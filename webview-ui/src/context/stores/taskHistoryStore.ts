import { type ExtensionMessage, type HistoryItem } from "@roo-code/types"

import { StringCache } from "@src/utils/stringCache"

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
 *   `taskHistoryUpdated`). Interns the items before publishing.
 * - `upsertItem(item)`: the merge logic moved verbatim out of the
 *   `taskHistoryItemUpdated` case — replace by `id`, otherwise prepend, then
 *   sort newest-first (`b.ts - a.ts`) to keep UI semantics consistent with
 *   the extension.
 * - Interning: a store-owned `StringCache` (no filter — history items have no
 *   partial/streaming shape) replaces the `historyCache` role for the
 *   `taskHistory` array. `currentTaskItem` is NOT part of this store: it stays
 *   in the context, interned by the provider's remaining `historyCache`.
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
	 * `{type:"taskHistoryUpdated"}` post). Interns the items before publishing.
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
 * own history, listener set and StringCache, so tests can construct isolated
 * stores without cross-test leakage.
 */
export const createTaskHistoryStore = (): TaskHistoryStore => {
	let history: HistoryItem[] = []
	const listeners = new Set<() => void>()
	// Cross-task interning: the list holds every task ever run in this
	// workspace, so (like the old context-side historyCache) this cache is
	// never cleared on task switch — only by the explicit clear() below.
	const historyCache = new StringCache()
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
		// Intern BEFORE publishing so the snapshot's string fields point to the
		// canonical instances shared with prior posts.
		historyCache.intern(incoming)
		setHistory(incoming)
	}

	const upsertItem = (item: HistoryItem) => {
		historyCache.intern(item)
		const existingIndex = history.findIndex((h) => h.id === item.id)
		let next: HistoryItem[]
		if (existingIndex === -1) {
			next = [item, ...history]
		} else {
			next = history.slice()
			next[existingIndex] = item
		}
		// Keep UI semantics consistent with the extension: newest-first order.
		next.sort((a, b) => b.ts - a.ts)
		setHistory(next)
	}

	const clear = () => {
		historyCache.clear()
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
		getCacheSize: () => historyCache.size,
	}
}

/** Module singleton used by the app (provider mounts start/stop it). */
export const taskHistoryStore = createTaskHistoryStore()
