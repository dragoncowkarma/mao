# IPC surface and renderer testing

Tier 3 reference — read when touching `electron/ipc.ts`, `electron/preload.ts`, `electron/main.ts`, `src/` or `vitest.config.ts`. Rule summary: [AGENTS.md](../../../../AGENTS.md). Playbook: [SKILL.md](../SKILL.md).

The store-problem poll and list adoption in `src/App.tsx`: [store-and-recovery.md](store-and-recovery.md).
A channel's own rules live with its subsystem: `github:setRepos` in
[repo-preflight-and-swarm.md](repo-preflight-and-swarm.md), `workflow:*` in
[workflow-and-routing.md](workflow-and-routing.md).

## When adding an IPC channel

1. Implement the logic in `core/`, not in the shell.
2. `electron/ipc.ts`: `ipcMain.handle('<domain>:<camelCaseAction>', …)` as a one-line delegation.
   Domains: `app`, `ai`, `github`, `workflow`, `ui`.
3. `electron/preload.ts`: same channel string, same namespace, positional args. The channel must be
   exactly `<namespace>:<method>` for the method it sits in.
4. `src/electron.d.ts`: mirror the signature. `npm run lint` fails while the method is missing from
   either side.
5. `src/test/electron-api-stub.ts`: add it to the fake bridge (`satisfies ElectronApi`, so lint fails
   until you do). Stub it as `notStubbed('<domain>.<action>')` unless a test or mount path needs an answer.
6. CLI parity needed? Add the matching subcommand in `cli/index.ts`.
7. Write the channel as a plain single-quoted literal on both sides. Never hoist it into a constant or
   template: the surface test refuses that, because it would remove the comparison's protection.
8. Run `npm run lint` and `npm run test`: neither proves the handler works. Smoke-test in `npm run dev`
   only with explicit authorization, otherwise report it unrun: it boots the real host (`resume: true`,
   auto-trigger, Electron `userData`; `MAO_DATA_DIR` does not apply), so it can write to GitHub.

## Compile-time half of the lockstep

- The bridge in `electron/preload.ts` carries `satisfies Window['electronAPI']`: a method missing from
  either side, an extra one, or a written parameter or return type that disagrees fails `npm run lint`.
- It still passes a method with fewer parameters (a dropped `base?`) or no return type: `invoke` returns
  `Promise<any>`, so tsc compares each method's written return type, never what `invoke` returns. Write
  the return type and forward every argument.
- Never remove it: `contextBridge.exposeInMainWorld` takes `any`, so deleting it silences every tsc
  check with lint still green. Only the surface test fails.
- `satisfies`, never a type annotation: the surface test requires a `satisfies` expression as the
  install's argument.

## Surface test contract

`src/electron-ipc-surface.test.ts` owns what no type reaches: channel strings and the bridge global
are untyped literals in separate files.
Focused run: `npx vitest run --project renderer src/electron-ipc-surface.test.ts`.

| Assertion | Failure it prevents |
| --- | --- |
| Handled and exposed channels are equal sets | An `invoke` with no handler; a handler no renderer reaches |
| Each channel registered once, exposed once | Startup throw on a second `handle`; two methods racing a channel |
| Channel is `<namespace>:<method>` of the invoking bridge method | A typo reported as two sorted lists, not the method |
| `exposeInMainWorld`'s first argument equals the sole `Window` member in `src/electron.d.ts` and a `window.<name>` read in `src/main.tsx`; exactly one install | A wrong global removes the whole bridge; a second install is not additive. A rename must land in all three |
| Floors on reached files, call counts and namespaces | A parser finding nothing passing vacuously |

### AST, failing closed

- It reads the TypeScript AST. Never move to text matching: a collector that skips what it cannot read
  shrinks both sides equally, so a real mismatch cancels out.
- **Channel argument:** every `ipcMain.handle` and `ipcRenderer.invoke` names its channel as a plain
  string literal. A template, constant or variable fails by file and line, though it would run.
- **Attribution:** every `invoke` sits inside a bridge namespace object, under a non-computed method.
- **Call form:** every reference to `ipcMain`, `ipcRenderer` or `contextBridge` must be the object of
  a direct `ipcMain.handle(…)`, `ipcRenderer.invoke(…)` or `contextBridge.exposeInMainWorld(…)` call.
  Refused by file and line: `ipcMain['handle'](…)`, a destructured method, aliasing the binding into
  a local, passing it as a value, `ipcMain.on`/`ipcRenderer.on` (send/on channels are not modelled).
- **Imports:** recognition resolves the `electron` import, not an identifier spelling.
  - Read: `import { ipcMain }` and the alias `import { ipcMain as main }`.
  - Ignored: `import type`, which binds no runtime value.
  - Refused on use: a default or namespace import; `electron.ipcMain.handle(…)` is a shape it does
    not read.
  - Refused: runtime `export … from 'electron'`, import-equals, `require('electron')`; a local facade
    could rename a binding before the scanner sees its import.

### Which modules count

- The surface is the runtime import graph from `electron/main.ts` and `electron/preload.ts`, crossing
  into `core/` because that code runs too. Never a directory listing: an unimported file does not
  count as registered, and an imported nested module does.
- `verbatimModuleSyntax: true` (`tsconfig.json`) is load-bearing and pinned: ordinary imports stay in
  the bundle even when used only as types, so the syntax walk cannot disagree with Vite.
- Only a whole-clause `import type` or `export type` erases an edge. `import { type Marker }` emits an
  empty side-effect import and still executes the module.
- Dynamic `import()` is refused, even with a literal target: it proves neither execution nor that the
  handler registers before the renderer invokes it.
- Static relative edges resolve through TypeScript (`./x.js` to `./x.ts`). An unresolved one is
  refused, not mistaken for an external package.
- Paths compare POSIX-normalised, because this repo ships to Windows.

### What the surface test does not cover

So a green run does not replace an authorized `npm run dev` smoke test:

- Whether the handler does the right thing.
- Anything the renderer swallows: a renderer that catches a rejected `invoke` (several do,
  deliberately) shows a broken channel as a feature that never appears.

## When touching renderer isolation (rule 6)

- `src/` never imports Node or Electron modules. Exception: tests, which run in a Node-hosted jsdom
  that never ships. No test pins this:
  `grep -rnE "from '(node:|electron)" src --exclude='*.test.*' --exclude-dir=test` must print nothing.
- Reach the main process only through `electronApi()` (`src/electron-api.ts`), bound once by
  `src/main.tsx`: a component wired to the global cannot be handed a fake.
- Proof: `src/electron-api.test.ts` fails on the identifier `electronAPI` anywhere in `src/` outside
  `src/electron.d.ts`, `src/electron-api.ts`, `src/main.tsx` and test code, comments included.
- Outside tests, from `core/` import types, plus values only from `core/agent-selection.ts`,
  `core/ai/provider-options.ts` and `core/repo-registry.ts`: they are pure, and their own `core/`
  imports are `import type` or another module on this list, so nothing Node-side enters the bundle.
- Never import a value from another `core/` module. Re-implementing one of these rules in `src/` is
  worse: the board and the registry then disagree on repository identity.
- No test pins that list. Check:
  `grep -rnE "from '(\.\./)+core/" src --exclude='*.test.*' --exclude-dir=test | grep -v 'import type'`.
- Renderer imports stay extensionless.
- No IPC push events: the UI polls and re-fetches after each mutation.

## Electron security posture (rule 7)

- In `electron/main.ts`, `webPreferences` sets only `preload`, so Electron 33 defaults apply
  (contextIsolation on, nodeIntegration off, sandbox on). Never weaken them.
- `setWindowOpenHandler` must keep returning `{ action: 'deny' }` and routing http/https to
  `shell.openExternal`. No test pins either.

## When touching the vitest config (rule 8)

- `vitest.config.ts` stays separate from `vite.config.ts`: the electron/renderer plugins shim node
  builtins and break `core/` under Node.
- A project inherits nothing from the root unless it opts in with `extends`, which keeps the two apart:
  - `core`: `core/**/*.test.ts`, `environment: 'node'`, zero plugins.
  - `renderer`: `src/**/*.test.ts`, `src/**/*.test.tsx`, `environment: 'jsdom'`,
    `@vitejs/plugin-react`, `src/test/setup.ts`.
- Never give `core` a plugin, a DOM environment or an `extends`. Never pull `vite-plugin-electron` or
  `vite-plugin-electron-renderer` into `renderer`.
- `npm run test` runs two `vitest run --project` invocations. Never merge them: a combined run
  tolerates a project whose `include` matches nothing (unnamed in the output, exit 0), so renaming test
  files retires a suite with CI green. Selecting a project that found nothing exits 1, the only loud
  form; `passWithNoTests: false` does not help at either level.
- Never place a test under `electron/`: neither project collects it, so it passes by never running.
- `core/node-environment.test.ts` fails when `core` gets a DOM: `environment` set on it, the projects
  collapsed into one root `test` block, or `extends` pointed at a config that has one.
- It cannot see a stray plugin on `core`: keep that out by reading the config. Root-level
  `test.environment` and plugins never reach an inline project.
- Outside vitest: `scripts/check-origin.test.mjs` (`npm run test:origin`) and
  `.agents/workflows/swarm_orchestrator_test.py` (through `npm run test`, so Python 3 is required).

## When writing renderer code

- Design tokens are CSS variables in `:root` of `src/index.css`. `tailwind.config.js` stays stock:
  never add tokens to the Tailwind theme, never hardcode hex in TSX.
- Reusable visuals are semantic classes (`.btn`, `.card`, `.tag`, …) in `@layer components`; Tailwind
  utilities only for one-off layout tweaks.
- Sharp corners on purpose (`--radius-md: 0px`): no `rounded-*`. The `rounded-full` badge in
  `src/components/GlobalSettings.tsx` is an existing violation, not a precedent.
- `src/index.css` names 'Archivo', but nothing loads it. Never add external font links (offline app).
- Plain `useState`/`useEffect`, props-down/callbacks-up. No context, store or data-fetching libraries.
- Polling effects must `clearInterval` in cleanup and tolerate StrictMode double-invocation.
- A behaviour change needs a test under `src/**/*.test.tsx`; run `npx vitest run --project renderer`.
  `tsc --noEmit` reads types and `npx vite build` proves the bundle links: both stay green for code
  that stack-overflows on the first click.

## When adding a renderer regression test

1. Put it beside what it covers: `src/App.test.tsx`, `src/components/<Name>.test.tsx`.
2. `const stub = createElectronApiStub([...repos])` (`src/test/electron-api-stub.ts`) binds a fake
   bridge and returns its mocks. Unimplemented channels throw by name rather than answering empty.
3. Mount the real component: `render(<StrictMode><App /></StrictMode>)`, because `src/main.tsx` does.
   StrictMode's doubled effects (dev and tests, never the packaged build) are what exercise the
   polling-effect rule. Every mount-path IPC call runs twice, so assert what the operator sees or
   `toHaveBeenCalledWith`, never a bare `toHaveBeenCalledTimes`.
4. Query as an operator sees it: `getByRole('heading', …)`,
   `getByRole('button', { name: 'Confirm remove' })`. The markup has no test ids.
5. Stage a slow IPC round trip, the shape most renderer races take:

   ```ts
   stub.setRepos.mockImplementationOnce(async (next: RepoRef[]) => {
     await deferred
     stub.applyRepos(next)
     return []
   })
   ```

   Assert on the UI after a signal that the continuation ran (the Add form closing, or one more
   `stub.getRepos` call). Never a bare `waitFor` on the assertion itself: it passes before the code
   under test reaches it.
6. Keep real timers: every polling interval is cleared on unmount, and a real-timer linger produces no
   `act()` warnings. Never combine `vi.useFakeTimers()` with `@testing-library/user-event`: a single
   `user.click` hangs to the test timeout. To test polling, use `fireEvent` and
   `await act(async () => { await vi.advanceTimersByTimeAsync(...) })`, restoring
   `vi.useRealTimers()` in `finally` (examples: `src/App.test.tsx`).
7. `src/test/setup.ts` unmounts and unbinds the bridge after every test. Do not add your own cleanup
   for those.
8. Prove it load-bearing: revert the behaviour it describes and watch it fail. Say in the PR which
   mutation you ran, and say so too when a test turns out not to discriminate.
