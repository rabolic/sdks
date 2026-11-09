/**
 * AsyncStorage behind core's synchronous store: every key the SDK uses is
 * read once at startup into memory, and writes go to memory at once and to
 * AsyncStorage in the background, one at a time and in order.
 */
import type { KeyValueStore, Logger } from '@rabolic/sdk-core'
import type { AsyncStorageLike } from './host'

/** AsyncStorage is shared by the whole app; the SDK's keys carry this prefix. */
export const KEY_PREFIX = '@rabolic/'

export interface HydratedStore extends KeyValueStore {
  /** Resolves when every write so far has reached AsyncStorage. */
  settled(): Promise<void>
}

export async function hydrateStore(storage: AsyncStorageLike, keys: readonly string[], logger: Logger): Promise<HydratedStore> {
  const values = new Map<string, string>()
  await Promise.all(
    keys.map(async (key) => {
      try {
        const value = await storage.getItem(KEY_PREFIX + key)
        if (typeof value === 'string') values.set(key, value)
      } catch (error) {
        logger.debug('storage read failed', key, error)
      }
    }),
  )
  let chain: Promise<void> = Promise.resolve()
  const write = (task: () => Promise<void>) => {
    chain = chain.then(task).catch((error: unknown) => logger.debug('storage write failed', error))
  }
  return {
    get: (key) => values.get(key) ?? null,
    set(key, value) {
      if (values.get(key) === value) return
      values.set(key, value)
      write(() => storage.setItem(KEY_PREFIX + key, value))
    },
    remove(key) {
      if (!values.has(key)) return
      values.delete(key)
      write(() => storage.removeItem(KEY_PREFIX + key))
    },
    settled: () => chain,
  }
}
