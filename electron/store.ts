import Store from 'electron-store'
import { MAO_STORE_DEFAULTS, type MaoStoreSchema } from '../core/store.ts'

export const store = new Store<MaoStoreSchema>({
  defaults: MAO_STORE_DEFAULTS,
})
