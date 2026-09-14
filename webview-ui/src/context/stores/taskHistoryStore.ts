import { type ExtensionMessage, type HistoryItem } from "@roo-code/types"

import { CanonicalRegistry, sameElements } from "./dedupRegistry"

/**
 * TaskHistoryStore — the frontend slice that owns the workspace `taskHistory`
 * OUTSIDE of React state (Task 1 of plans/streaming-event-architecture.md),
 * modeled on ClineMessagesStore but deliberately simpler:
 *
 * - No seq guard: history posts are last-write-wins full lists / single-item
 *   upserts, there is no per-item sequence number to reconcile.
 * - No task-switch clear: the history is cross-task by design (it holds every
 *   task ever run in this workspace), so a `currentTaskId` change must NOT
 *   drop it. Only `clear()` (tests / provider lifecycle) empties it.
 *
 * Problem it solves: `taskHistory` lived in `ExtensionStateContext`, so every
 * `taskHistoryUpdated` / `taskHistoryItemUpdated` / full-state post recreated
 * the context value → re-render of every consumer (HistoryView, useTaskSearch
 * memo churn, usePromptHistory, ChatView). With the store, only components
 * that subscribe through `useTaskHistory()` re-render, and only when the
 * history snapshot reference actually changes (skip-notify).
 *
 * Domain semantics (mirroring the previous ExtensionStateContext behavior):
 * - `replaceAll(items)`: full-list hydration (state posts and
 *   `taskHistoryUpdated`). Canonicalizes the items before publishing; a
 *   re-post whose content is unchanged publishes nothing at all.
 * - `upsertItem(item)`: the merge logic moved verbatim out of the
 *   `taskHistoryItemUpdated` case — replace by `id`, otherwise prepend, then
 *   sort newest-first (`b.ts - a.ts`) to keep UI semantics consistent with
 *   the extension.
 * - Canonicalization: a store-owned `CanonicalRegistry` keyed by `id` interns
 *   strings internally (no filter — history items have no partial/streaming
 *   shape) and keeps one canonical instance per item. `currentTaskItem` is NOT
 *   part of this store: it stays in the context, interned by the provider's
 *   remaining `historyCache`.
 * - Skip-notify: no listener is called when the snapshot did not change.
 *
 * Self-hydration: like ClineMessagesStore, the module singleton attaches a
 * `window` "message" listener (`start()`/`stop()`, mounted by the provider) so
 * history events reach the store without a bus on the IPC → store path. Tests
 * hydrate via `window.dispatchEvent(new MessageEvent("message", { data: ... }))`
 * — the same delivery the real extension host uses.
 */
export interface TaskHistoryStore {
	/** useSyncExternalStore contract: current immutable snapshot. */
	getSnapshot: () => HistoryItem[]
	/** useSyncExternalStore contract: returns an unsubscribe function. */
	subscribe: (listener: () => void) => () => void

	/**
	 * Full-list hydration (a `{type:"state"}` post with `taskHistory`, or a
	 * `{type:"taskHistoryUpdated"}` post). Canonicalizes the items (string
	 * interning + one reference per `id`) before publishing; a re-post whose
	 * every element maps back to the snapshot publishes nothing (skip-notify).
	 */
	replaceAll: (items: HistoryItem[]) => void

	/**
	 * Single-item merge for `{type:"taskHistoryItemUpdated"}`: replace by `id`,
	 * otherwise prepend, then re-sort newest-first.
	 */
	upsertItem: (item: HistoryItem) => void

	/** Drop the history and the interned strings. */
	clear: () => void

	/**
	 * Attaches the self-hydrating window "message" listener. Idempotent.
	 * Call from the provider's mount effect; detach with `stop()` on unmount.
	 */
	start: () => void

	/** Detaches the self-hydrating window "message" listener. Idempotent. */
	stop: () => void

	/** Test-only: number of interned strings (StringCache.size). */
	getCacheSize: () => number
}

/**
 * Factory form (mirrors `createClineMessagesStore`): each instance owns its
 * own history, listener set and canonical registry (string interning
 * included), so tests can construct isolated stores without cross-test
 * leakage.
 */
export const createTaskHistoryStore = (): TaskHistoryStore => {
	let history: HistoryItem[] = []
	const listeners = new Set<() => void>()
	// Cross-task canonicalization (the registry owns the string interning): the
	// list holds every task ever run in this workspace, so — like the old
	// context-side historyCache — nothing is cleared on task switch, only by
	// the explicit clear() below.
	const historyRegistry = new CanonicalRegistry<HistoryItem>((item) => item.id)
	let started = false

	const notify = () => {
		for (const listener of listeners) {
			listener()
		}
	}

	const setHistory = (next: HistoryItem[]) => {
		if (next === history) {
			// No reference change — nothing to publish (skip-notify).
			return
		}
		history = next
		notify()
	}

	const replaceAll = (incoming: HistoryItem[]) => {
		// Canonicalize BEFORE publishing: strings re-bind to the shared
		// instances and every item maps back to its registered reference. A
		// re-post of unchanged content comes back element-wise equal to the
		// current snapshot → skip-notify.
		const canonical = historyRegistry.internList(incoming)
		if (sameElements(canonical, history)) {
			return
		}
		setHistory(canonical)
	}

	const upsertItem = (item: HistoryItem) => {
		// Interning + canonical reference in one step: an identical-content
		// re-post maps back to the instance already in the snapshot, while a
		// genuinely changed item (e.g. updated totalCost) is adopted.
		const canonical = historyRegistry.intern(item)
		const existingIndex = history.findIndex((h) => h.id === canonical.id)
		if (existingIndex !== -1 && history[existingIndex] === canonical) {
			// Duplicate post — the snapshot already carries the canonical
			// instance. Identical content means identical `ts`, so the sort
			// below would not move anything either: skip-notify.
			return
		}
		let next: HistoryItem[]
		if (existingIndex === -1) {
			next = [canonical, ...history]
		} else {
			next = history.slice()
			next[existingIndex] = canonical
		}
		// Keep UI semantics consistent with the extension: newest-first order.
		next.sort((a, b) => b.ts - a.ts)
		setHistory(next)
	}

	const clear = () => {
		// Drops the canonical references AND the interned strings (the registry
		// owns the StringCache).
		historyRegistry.clear()
		// Fresh empty array so an existing [] snapshot reference still resets
		// listeners that hold the previous list.
		setHistory([])
	}

	const handleMessage = (event: MessageEvent) => {
		const message = event.data as ExtensionMessage
		switch (message.type) {
			case "state": {
				// Commit 4 made the state posts lean: the extension OMITS the
				// taskHistory key when includeTaskHistory is false (conditional
				// spread), so an absent key must keep the current list.
				if (message.state?.taskHistory !== undefined) {
					replaceAll(message.state.taskHistory)
				}
				break
			}
			case "taskHistoryUpdated": {
				if (message.taskHistory !== undefined) {
					replaceAll(message.taskHistory)
				}
				break
			}
			case "taskHistoryItemUpdated": {
				if (message.taskHistoryItem !== undefined) {
					upsertItem(message.taskHistoryItem)
				}
				break
			}
			default:
				break
		}
	}

	const start = () => {
		if (started) {
			return
		}
		started = true
		window.addEventListener("message", handleMessage)
	}

	const stop = () => {
		if (!started) {
			return
		}
		started = false
		window.removeEventListener("message", handleMessage)
	}

	return {
		getSnapshot: () => history,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		replaceAll,
		upsertItem,
		clear,
		start,
		stop,
		getCacheSize: () => historyRegistry.stringCacheSize,
	}
}

/** Module singleton used by the app (provider mounts start/stop it). */
export const taskHistoryStore = createTaskHistoryStore()
