import { useCallback, useRef, useSyncExternalStore } from "react"

/**
 * StoreBase — the shared React plumbing for the webview slice stores
 * (ClineMessagesStore, TaskHistoryStore).
 *
 * A store owns an immutable snapshot record and a listener set; React
 * consumers attach through the inherited hooks instead of module-level hook
 * files. The snapshot is a record (not a bare array): every publish swaps the
 * whole object, while the FIELDS inside it carry the identity guarantees —
 * a field reference only changes when its value effectively changed (the
 * store's derive step is responsible for that). `useSelector` keys on those
 * per-field references, so a subscriber re-renders only when one of the
 * fields it selected moved, never on incidental snapshot-object churn.
 */
export abstract class StoreBase<TSnapshot extends object> {
	private readonly listeners = new Set<() => void>()

	/** useSyncExternalStore contract: current immutable snapshot. */
	abstract getSnapshot(): TSnapshot

	/**
	 * useSyncExternalStore contract: returns an unsubscribe function. An arrow
	 * field so `store.subscribe` stays bound when React detaches it from the
	 * instance.
	 */
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	/** Publishes the current snapshot to every listener (skip-notify is the caller's job). */
	protected notify(): void {
		for (const listener of this.listeners) {
			listener()
		}
	}

	/**
	 * React hook: subscribes to the named snapshot fields and returns their
	 * current values as a tuple in the same order:
	 *
	 * ```ts
	 * const [messages, lastMessage, count] = messageStore.useSelector("messages", "lastMessage", "count")
	 * ```
	 *
	 * Re-renders only when one of the SELECTED fields changes reference
	 * (Object.is). The per-hook-instance cache keys on the snapshot reference
	 * first (same snapshot => same values, the store guarantees it) and then
	 * on the selected field values, so a publish that swaps the snapshot
	 * object without moving the selected fields reuses the cached tuple and
	 * React sees no change.
	 */
	useSelector<const TKey extends readonly (keyof TSnapshot)[]>(
		...keys: TKey
	): { [TIndex in keyof TKey]: TSnapshot[TKey[TIndex]] } {
		type Selected = { [TIndex in keyof TKey]: TSnapshot[TKey[TIndex]] }

		// Keep the store and the key list in refs so `getSnapshot` (stable
		// identity — a hard useSyncExternalStore requirement) always sees the
		// values from the current render without re-subscribing. Call sites
		// pass literal keys, so the list never actually varies between renders.
		const storeRef = useRef(this)
		storeRef.current = this
		const keysRef = useRef(keys)
		keysRef.current = keys

		// Per-hook-instance result cache: recomputed only when the snapshot
		// reference actually changed; reused while every selected field stays
		// Object.is-equal, which keeps getSnapshot referentially stable between
		// meaningful notifications (no infinite re-render loop).
		const cacheRef = useRef<{ snapshot: TSnapshot; selected: Selected } | null>(null)

		const getSnapshot = useCallback((): Selected => {
			const snapshot = storeRef.current.getSnapshot()
			const cache = cacheRef.current
			if (cache !== null && cache.snapshot === snapshot) {
				return cache.selected
			}
			// `.map` over the key tuple yields a union-typed array; the element order is
			// exactly the key order, so the mapped tuple type is a precise refinement
			// that TS cannot verify through `.map` (no tuple-length inference) — hence
			// the double assertion as the last resort for tuple-typed results.
			const selected = keysRef.current.map((key) => snapshot[key]) as unknown as Selected
			if (
				cache !== null &&
				cache.selected.length === selected.length &&
				cache.selected.every((value, index) => Object.is(value, selected[index]))
			) {
				// Selected fields unchanged — keep the cached tuple identity and
				// just re-key it to the new snapshot.
				cache.snapshot = snapshot
				return cache.selected
			}
			cacheRef.current = { snapshot, selected }
			return selected
		}, [])

		return useSyncExternalStore(storeRef.current.subscribe, getSnapshot)
	}
}
