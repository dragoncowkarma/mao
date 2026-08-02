import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts: the electron/renderer plugins there shim
// node builtins for the browser bundle, which breaks electron/*.ts running under Node in tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts'],
  },
})
