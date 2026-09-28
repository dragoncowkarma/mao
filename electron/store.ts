import Store from 'electron-store'
import {
  createStoredReadGuard,
  describeStoredProblems,
  MAO_STORE_DEFAULTS,
  type MaoStore,
  type MaoStoreSchema,
  type StoredValueProblem,
} from '../core/store.ts'

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
/**
 * The raw stored value, with conf's one behavioural difference from `FileStore` ironed out.
 *
 * conf merges `defaults` into the file once, when it first writes it, and its `get()` is then
 * `key in store ? store[key] : defaultValue` over the file's *current* contents — so a key an operator
 * deletes by hand comes back `undefined`, where `FileStore`'s constructor spread substitutes the schema
 * default. Left alone, the same edited file made the GUI report a discarded value (and offer to reset
 * it) while the CLI reported a clean store, which is exactly the divergence routing both backends
 * through one guard exists to prevent. Cloned, never the shared `MAO_STORE_DEFAULTS` instance, for the
 * reason `FileStore`'s constructor clones it too.
 */
function readRaw<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
  const value = backing.get(key) as MaoStoreSchema[K] | undefined
  return value === undefined ? structuredClone(MAO_STORE_DEFAULTS[key]) : value
}

export const store: MaoStore = {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    return guardRead(key, readRaw(key))
  },
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    backing.set(key, value)
  },
  problems(): StoredValueProblem[] {
    return describeStoredProblems(readRaw, backing.path)
  },
}
