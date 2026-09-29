import Store from 'electron-store'
import { createGuardedStore, MAO_STORE_DEFAULTS, type MaoStore, type MaoStoreSchema } from '../core/store.ts'

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
 */
export const store: MaoStore = createGuardedStore(backing, backing.path)
