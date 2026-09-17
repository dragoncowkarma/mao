import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { setElectronApi } from '../electron-api'

/**
 * jsdom ships no media-query engine, so `window.matchMedia` is simply absent — and App's theme effect
 * calls it during its first commit, which would make *every* renderer test fail on mount for a reason
 * unrelated to what it is testing. The stub reports "not dark" and accepts listeners without ever
 * firing them; a test that cares about the OS theme should replace it rather than extend it, so the
 * default stays boring.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

afterEach(() => {
  // Unmounting is not optional here: App and KanbanBoard start polling intervals on mount, and a
  // leaked tree keeps firing them into the next test's bridge. The repo runs vitest without `globals`,
  // so Testing Library never finds an ambient `afterEach` to register its own auto-cleanup on.
  cleanup()
  // Then drop the bridge, so anything that outlived cleanup fails with the accessor's message instead
  // of quietly recording calls against a stub the next test is asserting on.
  setElectronApi(null)
})
