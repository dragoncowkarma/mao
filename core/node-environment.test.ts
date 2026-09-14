import { describe, expect, it } from 'vitest'

/**
 * Architecture rule 8 as a test rather than a paragraph.
 *
 * The rule survives only as long as `vitest.config.ts` keeps the `core` project on
 * `environment: 'node'` — a boundary one edit away from dissolving, and whose dissolution nothing
 * else would report. A `core` project handed a DOM runs every existing test to green, because a DOM
 * is extra, not missing; what breaks is `mao run` and the Electron main process, where `core/`
 * executes with no `window` at all. So the boundary is asserted from inside the project it protects.
 *
 * Three edits can do it, and all three fail here: `environment` set on this project, the two projects
 * collapsed back into a single root `test` block, and `extends` pointed at a config that has a DOM. A
 * root-level `test.environment` sitting *beside* `projects` is not one of them — an inline project
 * inherits nothing without `extends` — which is the same reason a root plugin is invisible here.
 *
 * The renderer's `setupFiles` needs no separate assertion: `src/test/setup.ts` touches `window` while
 * loading, so a setup file that leaked in here would take the whole project down with it.
 *
 * This is deliberately not a test of any module under `core/` — it is a test of how `core/` is run.
 */
describe('the core vitest project', () => {
  it('runs with no DOM in scope', () => {
    expect(typeof globalThis.window).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')
  })
})
