import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the electron/renderer plugins there shim node builtins
// for the browser bundle, which breaks core/*.ts running under Node in tests.
//
// Two projects rather than one shared environment, because the two halves of this repo need opposite
// things from a test runner: core/ must keep proving it runs as plain Node with no bundler in the way
// (architecture rule 8), while src/ cannot be exercised at all without a DOM and a JSX transform.
// A project inherits nothing from this file unless it opts in with `extends`, so the renderer's
// jsdom globals and React plugin cannot reach core/ — which is what keeps rule 8 true by construction
// instead of by convention. `vitest run` runs both and labels each test with its project name.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['core/**/*.test.ts'],
        },
      },
      {
        // React's automatic JSX runtime, and nothing else. vite-plugin-electron and
        // vite-plugin-electron-renderer stay out on purpose: they exist to shim node builtins for the
        // packaged bundle, which is exactly the drift rule 8 is written against.
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
          // Chosen rather than inherited. These tests mount the whole component tree and drive it
          // through user-event, which is thousands of small async ticks and degrades superlinearly
          // under CPU contention: measured here, the slowest takes 370ms idle but 4.9s at 3x
          // oversubscription, and blows the 5s default at 6x. A 2-vCPU CI runner sharing the box with
          // 14 parallel core test files is exactly that regime, and a timeout failure reads as
          // "the renderer tests are flaky" — which gets acted on by deleting them.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
})
