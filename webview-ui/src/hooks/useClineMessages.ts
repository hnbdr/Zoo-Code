import { useCallback, useRef, useSyncExternalStore } from "react"

import { type ClineMessage, type TodoItem, type TokenUsage } from "@roo-code/types"

import {
	clineMessagesStore,
	type DerivedMessageState,
	type LastMessageFlags,
} from "@src/context/stores/clineMessagesStore"

/**
 * React bindings for the ClineMessagesStore (Commit 2 of
 * plans/streaming-event-architecture.md). Components that render streaming
 * message data subscribe through these hooks instead of `useExtensionState()`,
 * so a stream push re-renders ONLY the subscribed consumers and not the whole
 * context tree.
 *
 * `useClineMessages()` returns the full snapshot array — it re-renders on every
 * flush (snapshot reference change). `useClineMessagesSelector(selector)`
 * re-renders only when the selector's RESULT changes (Object.is), so stable
 * derived values (e.g. `m.at(0)` — the task message object reference is stable
 * across partial-text flashes of later messages) do not re-render subscribers.
 *
 * Selector contract: selectors should be pure functions of the snapshot and
 * return a stable reference for unchanged state (an element already inside the
 * snapshot like `m.at(0)`, or a primitive). The per-hook-instance cache below
 * also guards against selectors that allocate fresh references: the cached
 * result is reused until the underlying snapshot reference changes, which keeps
 * getSnapshot stable between notifications (no infinite re-render loop).
 */
export const useClineMessages = (): ClineMessage[] =>
	useSyncExternalStore(clineMessagesStore.subscribe, clineMessagesStore.getSnapshot)

export function useClineMessagesSelector<T>(selector: (messages: ClineMessage[]) => T): T {
	// Keep the latest selector in a ref so `getSnapshot` (stable identity — a
	// hard useSyncExternalStore requirement) always sees the selector from the
	// current render without re-subscribing.
	const selectorRef = useRef(selector)
	selectorRef.current = selector

	// Per-hook-instance result cache: recompute only when the messages snapshot
	// reference actually changed. Between store notifications the cached result
	// is returned as-is, so getSnapshot stays referentially stable and React
	// never sees a snapshot change it did not subscribe to.
	const cacheRef = useRef<{ messages: ClineMessage[]; result: T } | null>(null)

	const getSnapshot = useCallback((): T => {
		const snapshot = clineMessagesStore.getSnapshot()
		const cached = cacheRef.current
		if (cached === null || cached.messages !== snapshot) {
			const result = selectorRef.current(snapshot)
			cacheRef.current = { messages: snapshot, result }
			return result
		}
		return cached.result
	}, [])

	return useSyncExternalStore(clineMessagesStore.subscribe, getSnapshot)
}

/**
 * Derived-slice bindings (plans/derived-store-revision.md §2.2). The store
 * computes the boundary facts once per real snapshot change; these hooks
 * expose them to the shell without the old MessageStream -> ChatView uplink.
 *
 * `useMessageDerived()` subscribes to the whole slice — because the slice
 * object is only recreated when at least one field changed reference, this
 * re-renders exactly on boundary events (never on partial-text growth).
 */
export const useMessageDerived = (): DerivedMessageState =>
	useSyncExternalStore(clineMessagesStore.subscribe, clineMessagesStore.getDerived)

/**
 * Point subscription into the derived slice. The per-hook-instance cache keys
 * on the `derived` reference (the store guarantees: same reference => same
 * values), so selectors that allocate (e.g. destructuring into a new object)
 * still return a stable result between notifications — the same contract as
 * `useClineMessagesSelector` has for the raw snapshot.
 */
export function useMessageDerivedSelector<T>(selector: (derived: DerivedMessageState) => T): T {
	// Keep the latest selector in a ref so `getSnapshot` (stable identity — a
	// hard useSyncExternalStore requirement) always sees the selector from the
	// current render without re-subscribing.
	const selectorRef = useRef(selector)
	selectorRef.current = selector

	const cacheRef = useRef<{ derived: DerivedMessageState; result: T } | null>(null)

	const getSnapshot = useCallback((): T => {
		const derived = clineMessagesStore.getDerived()
		const cached = cacheRef.current
		if (cached === null || cached.derived !== derived) {
			const result = selectorRef.current(derived)
			cacheRef.current = { derived, result }
			return result
		}
		return cached.result
	}, [])

	return useSyncExternalStore(clineMessagesStore.subscribe, getSnapshot)
}

// Typed wrappers over the derived slice. Each selects a field whose reference
// the store already stabilized, so subscribers only re-render when that field
// actually moved.

/** The task row (`messages.at(0)`) or undefined before the first flush. */
export const useTask = (): ClineMessage | undefined => useMessageDerivedSelector((derived) => derived.task)

/**
 * The last message, boundary-key stabilized: text growth inside a partial
 * keeps the previous reference (see DerivedMessageState docs).
 */
export const useLastMessage = (): ClineMessage | undefined =>
	useMessageDerivedSelector((derived) => derived.lastMessage)

/** Raw message count (changes on append, not on text growth). */
export const useMessageCount = (): number => useMessageDerivedSelector((derived) => derived.count)

/** Aggregated token/cost metrics over the modified stream. */
export const useApiMetrics = (): TokenUsage => useMessageDerivedSelector((derived) => derived.apiMetrics)

/** Todos of the latest updateTodoList row (identity: JSON signature). */
export const useLatestTodos = (): TodoItem[] => useMessageDerivedSelector((derived) => derived.latestTodos)

/** The isStreaming flag bundle as one reference-stable object. */
export const useLastMessageFlags = (): LastMessageFlags =>
	useMessageDerivedSelector((derived) => derived.lastMessageFlags)
