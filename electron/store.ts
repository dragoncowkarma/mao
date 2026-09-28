import Store from 'electron-store'
import { createStoredReadGuard, MAO_STORE_DEFAULTS, type MaoStore, type MaoStoreSchema } from '../core/store.ts'

/**
 * Constructed with no `clearInvalidConfig`, so conf's `false` default stands — and that is deliberate, not
 * an omission. conf reads the config file from inside this constructor, so an unparseable or unreadable
 * `config.json` throws here and nothing is written, which is the behaviour `FileStore` was changed to match
 * (see `describeUnreadableStore` in core/store.ts for why booting on defaults instead destroys the stored
 * token). Enabling the option would read `{}`, merge the defaults, and write them straight back from this
 * line — losing the file before any `set()` ran. `core/store.test.ts` pins it off.
 */
const backing = new Store<MaoStoreSchema>({ defaults: MAO_STORE_DEFAULTS })

/**
 * electron-store's `defaults` fills in only the keys that are *missing*, so a `config.json` whose
 * `githubRepos` is present but not an array reaches every reader as a non-array under a type that says
 * `RepoRef[]` — the GUI half of issue #60. `github:getRepos` rejected on `.filter`, so the sidebar stayed
 * empty behind an unhandled rejection, and `github:setRepos` failed too, so the Add form could not write
 * the list that would have healed it. Reads therefore go through core's guard, the same one `FileStore`
 * applies, so the two shells cannot answer differently for the same corrupt file.
 *
 * The policy and its operator-facing message live in core (`createStoredReadGuard`); this file stays a
 * delegation, as AGENTS.md rule 2 requires of a shell. `backing.path` is electron-store's resolved
 * config file, so the report names the file the operator actually has to edit.
 */
const guardRead = createStoredReadGuard(backing.path)

/**
 * Typed as `MaoStore` rather than as the electron-store instance on purpose: the only thing the main
 * process may do with persistence is the core contract, and narrowing it here keeps a future handler
 * from reaching past the guard through electron-store's own API.
 */
export const store: MaoStore = {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    return guardRead(key, backing.get(key))
  },
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    backing.set(key, value)
  },
}
