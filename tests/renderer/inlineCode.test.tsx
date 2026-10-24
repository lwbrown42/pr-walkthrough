import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import InlineCode from '../../src/renderer/src/components/InlineCode'

afterEach(cleanup)

const codes = (text: string): string[] => {
  const { container } = render(<InlineCode text={text} />)
  return [...container.querySelectorAll('code')].map((c) => c.textContent ?? '')
}

describe('InlineCode', () => {
  it('turns backtick pairs into code', () => {
    expect(codes('use `foo` and `bar`')).toEqual(['foo', 'bar'])
  })

  it('leaves an unpaired backtick as text', () => {
    const { container } = render(<InlineCode text="a `b` c `d" />)
    expect([...container.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['b'])
    expect(container.textContent).toBe('a b c `d')
  })

  it('does not interpret HTML', () => {
    const { container } = render(<InlineCode text="`<b>x</b>` <i>y</i>" />)
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('i')).toBeNull()
  })
})
