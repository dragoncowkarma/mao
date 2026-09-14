/**
 * The renderer's single door to the main process.
 *
 * `window.electronAPI` is installed by the preload bridge, so reading it directly — as every component
 * used to — hard-wires each of them to a global that only exists inside Electron. That is fine at
 * runtime and fatal for testing: a renderer test would have to boot a browser-shaped global before the
 * module graph loads, and it could never hand two tests different bridges.
 *
 * Binding it once here instead keeps the pull model AGENTS.md rule 6 prescribes (no Node/Electron
 * imports in `src/`, no IPC push events) while making the bridge an ordinary value: `src/main.tsx` is
 * the composition root that binds the real one, mirroring how `core/app.ts` is the single boot path
 * for everything below it, and a test binds a fake.
 */

/** The preload bridge's surface, named so tests and helpers can refer to it without `Window[...]`. */
export type ElectronApi = Window['electronAPI']

let bridge: ElectronApi | null = null

/**
 * Binds the bridge every component will call. Production calls this exactly once, from `src/main.tsx`
 * before the first render; tests call it per test with a stub and unbind with `null` afterwards so a
 * leaked interval from an unmounted tree fails loudly instead of writing into the next test's stub.
 */
export function setElectronApi(api: ElectronApi | null): void {
  bridge = api
}

/**
 * Throws rather than returning `undefined`: an unbound bridge means the preload script did not load,
 * and every call site is inside an effect or a click handler where a thrown message reaches the
 * operator (or the test) intact, whereas `undefined.github` would surface as a bare TypeError.
 */
export function electronApi(): ElectronApi {
  if (!bridge) {
    throw new Error('electronAPI is not available — the preload bridge did not load')
  }
  return bridge
}
