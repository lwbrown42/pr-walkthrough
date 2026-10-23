import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '../../src/renderer/src/components/ChatPanel'
import type { ChatMessage } from '../../src/shared/types'

const steps = [
  { id: 's1', title: 'First step' },
  { id: 's2', title: 'Second step' }
]

let chatCb: ((c: string) => void) | null
const unsub = vi.fn()
const ask = vi.fn()

beforeEach(() => {
  chatCb = null
  unsub.mockReset()
  ask.mockReset()
  ;(window as unknown as { api: object }).api = {
    ask,
    onChatText: (cb: (c: string) => void) => {
      chatCb = cb
      return unsub
    }
  }
})
afterEach(cleanup)

function Harness({
  stepId,
  initial = []
}: {
  stepId: string
  initial?: ChatMessage[]
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(initial)
  return (
    <ChatPanel
      stepId={stepId}
      steps={steps}
      messages={messages}
      onAppend={(m) => setMessages((prev) => [...prev, m])}
    />
  )
}

const box = (): HTMLElement => screen.getByPlaceholderText('Ask about this step…')

describe('ChatPanel', () => {
  it('sends a question, streams text live, then shows the final answer', async () => {
    let resolve!: (m: ChatMessage) => void
    ask.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<Harness stepId="s1" />)
    await userEvent.type(box(), 'Why?{Enter}')
    expect(ask).toHaveBeenCalledWith({ stepId: 's1', question: 'Why?' })
    expect(screen.getByText('Why?')).toBeTruthy()
    expect((box() as HTMLTextAreaElement).readOnly).toBe(true)
    act(() => chatCb?.('Because '))
    act(() => chatCb?.('of a.ts:3'))
    expect(screen.getByText('Because of a.ts:3')).toBeTruthy()
    await act(async () =>
      resolve({ id: 'a1', stepId: 's1', role: 'assistant', text: 'Final **answer**' })
    )
    expect(screen.queryByText('Because of a.ts:3')).toBeNull()
    expect(screen.getByText('Final **answer**')).toBeTruthy()
    expect(unsub).toHaveBeenCalled()
    expect((box() as HTMLTextAreaElement).readOnly).toBe(false)
    expect(document.activeElement).toBe(box())
  })

  it('Shift+Enter adds a newline and blank questions do not send', async () => {
    render(<Harness stepId="s1" />)
    await userEvent.type(box(), '   {Enter}')
    expect(ask).not.toHaveBeenCalled()
    await userEvent.clear(box())
    await userEvent.type(box(), 'a{Shift>}{Enter}{/Shift}b')
    expect((box() as HTMLTextAreaElement).value).toBe('a\nb')
    expect(ask).not.toHaveBeenCalled()
  })

  it('hides other steps and offers earlier questions grouped by step', async () => {
    const initial: ChatMessage[] = [
      { id: 'u1', stepId: 's1', role: 'user', text: 'Q one' },
      { id: 'a1', stepId: 's1', role: 'assistant', text: 'A one' },
      { id: 'u2', stepId: 's1', role: 'user', text: 'Q two' },
      { id: 'u3', stepId: 's2', role: 'user', text: 'Q three' }
    ]
    const { rerender } = render(<Harness stepId="s2" initial={initial} />)
    expect(screen.getByText('Q three')).toBeTruthy()
    expect(screen.queryByText('Q one')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show earlier questions (2)' }))
    expect(screen.getByText('First step')).toBeTruthy()
    expect(screen.getByText('Q one')).toBeTruthy()
    expect(screen.getByText('Q two')).toBeTruthy()
    rerender(<Harness stepId="s1" initial={initial} />)
    expect(screen.getByRole('button', { name: /Show earlier questions \(1\)/ })).toBeTruthy()
  })

  it('shows an ApiError inline and Retry resends without duplicating the question', async () => {
    ask.mockResolvedValueOnce({ error: { message: 'boom', reason: 'no_api_key' } })
    ask.mockResolvedValueOnce({ id: 'a1', stepId: 's1', role: 'assistant', text: 'ok now' })
    render(<Harness stepId="s1" />)
    await userEvent.type(box(), 'Hello{Enter}')
    await screen.findByText(/No API key set/)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('ok now')
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask).toHaveBeenLastCalledWith({ stepId: 's1', question: 'Hello' })
    expect(screen.getAllByText('Hello')).toHaveLength(1)
    expect(screen.queryByText(/No API key set/)).toBeNull()
  })

  it('unsubscribes on unmount while in flight', async () => {
    ask.mockReturnValue(new Promise(() => {}))
    const { unmount } = render(<Harness stepId="s1" />)
    await userEvent.type(box(), 'x{Enter}')
    await waitFor(() => expect(chatCb).not.toBeNull())
    unmount()
    expect(unsub).toHaveBeenCalled()
  })
})
