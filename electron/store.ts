import Store from 'electron-store'
import {
  createGuardedStore,
  MAO_STORE_DEFAULTS,
  withFileWriteLock,
  type MaoStore,
  type MaoStoreSchema,
} from '../core/store.ts'

const backing = new Store<MaoStoreSchema>({ defaults: MAO_STORE_DEFAULTS })

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
 * Typed as `MaoStore` rather than as the electron-store instance, and the instance is deliberately not
 * exported: the only thing the main process may do with persistence is the core contract, and a handler
 * that reached past it would read unvalidated values with nothing to flag it. `backing.path` is
 * electron-store's resolved config file, so the report names the file the operator has to edit.
 *
 * `withFileWriteLock` gives it the same cross-process write lock `FileStore` takes for that path (issue
 * #73), so the desktop app and a `mao` CLI pointed at one `config.json` serialize their writes against
 * each other. conf already re-reads the file before every `set` and replaces it atomically, so it needs
 * no change of its own to stop a write reverting another process's keys — the lock is what stops a
 * conditional write's compare being overtaken by a CLI write before its rename.
 */
export const store: MaoStore = createGuardedStore(withFileWriteLock(backing, backing.path), backing.path)
