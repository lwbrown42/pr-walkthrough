import { describe, expect, it } from 'vitest'
import { labelSteps } from '../../src/shared/stepLabels'
import type { Step } from '../../src/shared/walkthrough'

const step = (id: string, parentId?: string): Step => ({
  id,
  title: id,
  whyNext: '',
  explanation: '',
  segments: [],
  ...(parentId ? { parentId } : {})
})

describe('labelSteps', () => {
  it('numbers main steps and letters their detours', () => {
    const { labels, mainCount } = labelSteps([
      step('a'),
      step('a1', 'a'),
      step('a2', 'a'),
      step('b'),
      step('c'),
      step('c1', 'c')
    ])
    expect(labels).toEqual(['1', '1a', '1b', '2', '3', '3a'])
    expect(mainCount).toBe(3)
  })

  it('treats a detour that does not follow its main step as a main step', () => {
    expect(
      labelSteps([step('x', 'missing'), step('a'), step('b'), step('a1', 'a')]).labels
    ).toEqual(['1', '2', '3', '4'])
  })

  it('continues letters past z', () => {
    const steps = [step('a'), ...Array.from({ length: 27 }, (_, i) => step(`d${i}`, 'a'))]
    expect(labelSteps(steps).labels.slice(-2)).toEqual(['1z', '1aa'])
  })
})
