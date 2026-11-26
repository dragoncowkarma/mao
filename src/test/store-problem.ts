import type { MaoStoreSchema, StoredValueDefect, StoredValueProblem } from '../../core/store'

/**
 * A `StoredValueProblem` fixture whose `nothingUsable` is derived the way core derives it.
 *
 * Hand-written literals are what makes this worth a helper. `{ defect: 'some-entries', nothingUsable:
 * true }` is type-legal and cannot occur — core computes the second from the first in one place — but a
 * test that spelled it would "prove" the sidebar offers its whole-list reset for a partly usable
 * repository list, which is the exact deletion issue #72 exists to prevent. Deriving it here means a
 * fixture can state which *defect* it is describing and nothing else.
 *
 * Deliberately a copy of core's one-liner rather than an import of it: `src/` may not value-import
 * `core/store.ts` outside tests (AGENTS.md rule 6), and the renderer's job is to render what the main
 * process hands it. `core/store.test.ts` pins core's side of the pairing.
 */
export function storedValueProblem(
  field: keyof MaoStoreSchema,
  defect: StoredValueDefect,
  message: string,
  source = '/data/config.json',
): StoredValueProblem {
  return { field, source, message, defect, nothingUsable: defect !== 'some-entries' }
}
