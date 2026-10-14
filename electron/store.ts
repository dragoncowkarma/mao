import { app } from 'electron'
import path from 'node:path'
import Store from 'electron-store'
import { openGuardedStoreFile, MAO_STORE_DEFAULTS, type MaoStore, type MaoStoreSchema } from '../core/store.ts'

/**
 * Where electron-store would put the file anyway, resolved here instead of read back off the instance.
 *
 * `cwd` and `name` are pinned rather than left to electron-store's defaults, and that is load-bearing: the
 * file has to be judged *before* the instance exists (see `openGuardedStoreFile`), so there is no
 * `backing.path` to ask yet. Pinning both makes this path the same one conf will resolve, by construction
 * rather than by matching its defaults from memory. The values are exactly those defaults —
 * `app.getPath('userData')` and `config` — so an existing installation keeps reading the file it already
 * has.
 */
const configPath = path.join(app.getPath('userData'), 'config.json')

/**
 * electron-store, composed into a `MaoStore` by the same core function `FileStore` is.
 *
 * Nothing but the composition lives here on purpose. electron-store's `defaults` fills in only the keys
 * that are *missing*, so a `config.json` whose `githubRepos` is present but not an array reached every
 * reader as a non-array under a type that says `RepoRef[]` — the GUI half of issue #60, where
 * `github:getRepos` rejected on `.filter`, the sidebar stayed empty behind an unhandled rejection, and
 * `github:setRepos` failed too, so the Add form could not write the list that would have healed it.
 * `createGuardedStore` answers that, and also irons out conf's one behavioural difference from
 * `FileStore`: it merges `defaults` only when it first writes the file, so a key an operator deletes by
 * hand comes back `undefined`.
 *
 * `openGuardedStoreFile` is what makes conf safe to construct at all. conf builds its store inside its own
 * constructor, so for a `config.json` that is valid JSON but not an object it merges the defaults and
 * writes them straight back — destroying the file before any write gate exists to refuse it. Judging the
 * file first means `new Store(...)` is never reached for such a file, and rewrapping a construction failure
 * keeps conf's own parse error — which quotes the first ten characters of the file, and so the token in a
 * clobbered one — out of the main process's logs. Both halves are core's, not this shell's.
 *
 * `clearInvalidConfig` is deliberately not passed, so conf's `false` default stands: enabling it would make
 * conf answer `{}` for an unparseable file and then write the defaults over it, which is the same
 * destruction the gate above exists to prevent, moved inside the library where nothing can intercept it.
 *
 * This still throws at module load for a file it cannot use, and `electron/main.ts` imports this module
 * through `electron/ipc.ts`, so the app exits before a window exists and the operator sees no dialog. The
 * bytes survive, which is the point, and `mao config show` reports the cause against the same file — the
 * CLI's data directory is this one. Showing it in the GUI needs the construction moved off module scope
 * and is left to its own change.
 *
 * Typed as `MaoStore` rather than as the electron-store instance, and the instance is deliberately not
 * exported: the only thing the main process may do with persistence is the core contract, and a handler
 * that reached past it would read unvalidated values with nothing to flag it.
 */
export const store: MaoStore = openGuardedStoreFile(configPath, () =>
  new Store<MaoStoreSchema>({
    defaults: MAO_STORE_DEFAULTS,
    cwd: path.dirname(configPath),
    name: 'config',
  }),
)
