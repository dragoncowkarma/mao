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
 * The write refusal that closes issue #67 is inherited from `createGuardedStore`, not added here: conf
 * re-reads and re-parses the file on every `get`, so a file that becomes unreadable mid-session makes the
 * gate's fresh read throw and the write refuse, exactly as it does for `FileStore`.
 *
 * What is NOT covered, and must not be papered over: conf builds its store inside its own constructor, on
 * the `new Store(...)` line above, at module scope. An unparseable file rethrows there and the bytes
 * survive (`clearInvalidConfig` defaults to `false` — never set it to `true`, which would reset *and*
 * rewrite). But a file that is valid JSON and not an object — `null`, an array, a string, a number — does
 * not throw: conf's getter succeeds, its `assert.deepEqual` mismatch runs `this.store = store`, and the
 * file is rewritten with defaults before any `set()` exists to refuse it. See AGENTS.md's known-gap rail;
 * fixing it means validating the file before this line and moving the construction off module scope so the
 * throw is catchable and the operator can be shown a dialog.
 *
 * Typed as `MaoStore` rather than as the electron-store instance, and the instance is deliberately not
 * exported: the only thing the main process may do with persistence is the core contract, and a handler
 * that reached past it would read unvalidated values with nothing to flag it. `backing.path` is
 * electron-store's resolved config file, so the report names the file the operator has to edit.
 */
export const store: MaoStore = createGuardedStore(backing, backing.path)
