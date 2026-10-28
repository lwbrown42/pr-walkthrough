import { vi } from 'vitest'

// jsdom has no ResizeObserver; the walkthrough's resizable panels need one to mount.
if (!('ResizeObserver' in globalThis)) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
}
