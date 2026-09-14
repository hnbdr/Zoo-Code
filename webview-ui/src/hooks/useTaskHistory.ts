import { useRef, useSyncExternalStore } from "react"

import type { HistoryItem } from "@roo-code/types"

import { taskHistoryStore } from "@src/context/stores/taskHistoryStore"

/**
 * React binding for the TaskHistoryStore (Task 1 of
 * plans/streaming-event-architecture.md). Components that render task-history
 * data (HistoryView/useTaskSearch, usePromptHistory via ChatTextArea,
 * ChatView's HistoryPreview gate) subscribe through this hook instead of
 * `useExtensionState()`, so a history post re-renders ONLY the subscribed
 * consumers and not the whole context tree.
 *
 * The snapshot reference is store-managed: `replaceAll` with a fresh array of
 * identical content still changes the reference (content-deduplication via a
 * canonical registry is Task 2), so subscribers re-render on any real post —
 * exactly the previous context behavior, minus the context-wide churn.
 */
export const useTaskHistory = (): HistoryItem[] =>
	useSyncExternalStore(taskHistoryStore.subscribe, taskHistoryStore.getSnapshot)

/**
 * Selector form: re-renders only when the selector's RESULT changes
 * (Object.is). The per-hook-instance cache keys on the snapshot reference, so
 * selectors that allocate (e.g. `history.length > 0` is a primitive but
 * `history.filter(...)` is not) still return a stable result between
 * notifications — the same contract as `useClineMessagesSelector` has for the
 * messages snapshot.
 */
export function useTaskHistorySelector<T>(selector: (history: HistoryItem[]) => T): T {
	// Keep the latest selector in a ref so `getSnapshot` (stable identity — a
	// hard useSyncExternalStore requirement) always sees the selector from the
	// current render without re-subscribing.
	const selectorRef = useRef(selector)
	selectorRef.current = selector

	const cacheRef = useRef<{ history: HistoryItem[]; result: T } | null>(null)

	const getSnapshot = useRef(() => {
		const snapshot = taskHistoryStore.getSnapshot()
		const cached = cacheRef.current
		if (cached === null || cached.history !== snapshot) {
			const result = selectorRef.current(snapshot)
			cacheRef.current = { history: snapshot, result }
			return result
		}
		return cached.result
	}).current

	return useSyncExternalStore(taskHistoryStore.subscribe, getSnapshot)
}
