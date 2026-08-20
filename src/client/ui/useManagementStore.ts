/**
 * React binding for `ManagementStore`.
 *
 * `useSyncExternalStore` keeps the store framework-free while still giving
 * components a tear-free subscription. The store is created and torn down in an
 * effect so the poll timer and SSE connection never outlive the panel — under
 * StrictMode the double-mount discards the first store cleanly.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ManagementClient } from '../core/api.ts'
import { INITIAL_STATE, ManagementStore, type ManagementState } from '../core/store.ts'

export function useManagementStore(client: ManagementClient): {
  state: ManagementState
  store: ManagementStore | undefined
} {
  const [store, setStore] = useState<ManagementStore>()

  useEffect(() => {
    const created = new ManagementStore(client)
    setStore(created)
    created.start()
    return () => {
      created.stop()
      setStore(undefined)
    }
  }, [client])

  const state = useSyncExternalStore(
    onChange => store === undefined ? () => undefined : store.subscribe(onChange),
    () => store?.getState() ?? INITIAL_STATE,
    () => store?.getState() ?? INITIAL_STATE,
  )

  return { state, store }
}
