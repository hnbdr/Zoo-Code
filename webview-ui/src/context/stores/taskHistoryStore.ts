import equal from "fast-deep-equal"

import { type ExtensionMessage, type ExtensionState, type HistoryItem } from "@roo-code/types"

import { StoreBase } from "./storeBase"
import { CanonicalRegistry, sameElements } from "./dedupRegistry"
import { extractTaskHistoryPrompts } from "./promptHistory"

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
 * that subscribe through `taskHistoryStore.useSelector("history")` re-render,
 * and only when the `history` field reference actually changes (skip-notify).
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
 *   shape) and keeps one canonical instance per item. `currentTaskItem` (the
 *   active task's mirror) IS part of the snapshot: state posts seed it, and a
 *   `taskHistoryItemUpdated` whose id matches re-syncs it — the same guard the
 *   old provider-side merge applied before the history slice moved here.
 * - Skip-notify: no listener is called when the snapshot did not change.
 *
 * Hydration path: the store does not listen on `window` itself. The
 * ExtensionStateContextProvider routes the IPC messages into the public
 * `handleState` / `handleTaskHistoryUpdated` / `handleTaskHistoryItemUpdated`
 * handlers; tests drive the same handlers directly.
 */

/**
 * The published snapshot record. `history` is the raw canonical list;
 * `taskHistoryPrompts` is the prompt-history source (task texts for the
 * current workspace, bounded) derived alongside it. The prompts field keeps
 * its reference while the extracted strings are equal, so a `useSelector
 * ("taskHistoryPrompts")` subscriber ignores churn that does not change the
 * prompt list (a re-post, an unrelated item update, etc.).
 */
export interface TaskHistorySnapshot {
	history: HistoryItem[]
	taskHistoryPrompts: string[]
	currentTaskItem?: HistoryItem
}

/**
 * Each instance owns its history, listener set and canonical registry (string
 * interning included), so tests can construct isolated stores without
 * cross-test leakage.
 */
export class TaskHistoryStore extends StoreBase<TaskHistorySnapshot> {
	private history: HistoryItem[] = []
	private taskHistoryPrompts: string[] = []
	private currentTaskItem?: HistoryItem
	// Workspace used to filter the prompt list — mirrors the `cwd` the
	// extension posts with every state message. Until the first state post
	// arrives the prompt list stays empty (same as the old context-side
	// `!cwd` guard in usePromptHistory).
	private workspace: string | undefined
	private snapshot: TaskHistorySnapshot = {
		history: [],
		taskHistoryPrompts: [],
	}
	// Cross-task canonicalization (the registry owns the string interning): the
	// list holds every task ever run in this workspace, so — like the old
	// context-side historyCache — nothing is cleared on task switch, only by
	// the explicit clear() below.
	private readonly historyRegistry = new CanonicalRegistry<HistoryItem>((item) => item.id)
	private started = false

	/** useSyncExternalStore contract: current immutable snapshot record. */
	getSnapshot(): TaskHistorySnapshot {
		return this.snapshot
	}

	private setHistory(next: HistoryItem[]) {
		// Keep the published prompts reference while the extracted strings are
		// deep-equal — a fresh array with identical prompts never re-renders a
		// `useSelector("taskHistoryPrompts")` subscriber.
		const promptsCandidate = extractTaskHistoryPrompts(next, this.workspace)
		const prompts = equal(promptsCandidate, this.taskHistoryPrompts) ? this.taskHistoryPrompts : promptsCandidate
		if (
			next === this.history &&
			prompts === this.taskHistoryPrompts &&
			this.snapshot.currentTaskItem === this.currentTaskItem
		) {
			// Neither field moved — nothing to publish (skip-notify).
			return
		}
		this.history = next
		this.taskHistoryPrompts = prompts
		this.snapshot = { history: next, taskHistoryPrompts: prompts, currentTaskItem: this.currentTaskItem }
		this.notify()
	}

	/**
	 * Re-derives the prompt list when the workspace arrives/changes without a
	 * history change (state posts carry `cwd`). A no-op when the extracted
	 * prompts are unchanged (reference kept, skip-notify via setHistory).
	 */
	private setWorkspace(workspace: string | undefined) {
		if (workspace === undefined || workspace === this.workspace) {
			return
		}
		this.workspace = workspace
		this.setHistory(this.history)
	}

	/**
	 * Full-list hydration (a `{type:"state"}` post with `taskHistory`, or a
	 * `{type:"taskHistoryUpdated"}` post). Canonicalizes the items (string
	 * interning + one reference per `id`) before publishing; a re-post whose
	 * every element maps back to the snapshot publishes nothing (skip-notify).
	 */
	replaceAll(incoming: HistoryItem[]) {
		// Canonicalize BEFORE publishing: strings re-bind to the shared
		// instances and every item maps back to its registered reference. A
		// re-post of unchanged content comes back element-wise equal to the
		// current snapshot → skip-notify.
		const canonical = this.historyRegistry.internList(incoming)
		if (sameElements(canonical, this.history)) {
			return
		}
		this.setHistory(canonical)
	}

	/**
	 * Single-item merge for `{type:"taskHistoryItemUpdated"}`: replace by `id`,
	 * otherwise prepend, then re-sort newest-first.
	 */
	upsertItem(item: HistoryItem) {
		// Interning + canonical reference in one step: an identical-content
		// re-post maps back to the instance already in the snapshot, while a
		// genuinely changed item (e.g. updated totalCost) is adopted.
		const canonical = this.historyRegistry.intern(item)
		const existingIndex = this.history.findIndex((h) => h.id === canonical.id)
		if (existingIndex !== -1 && this.history[existingIndex] === canonical) {
			// Duplicate post — the snapshot already carries the canonical
			// instance. Identical content means identical `ts`, so the sort
			// below would not move anything either: skip-notify.
			return
		}
		let next: HistoryItem[]
		if (existingIndex === -1) {
			next = [canonical, ...this.history]
		} else {
			next = this.history.slice()
			next[existingIndex] = canonical
		}
		// Keep UI semantics consistent with the extension: newest-first order.
		next.sort((a, b) => b.ts - a.ts)
		this.setHistory(next)
	}

	/** Drop the history and the interned strings. */
	clear() {
		// Drops the canonical references AND the interned strings (the registry
		// owns the StringCache).
		this.historyRegistry.clear()
		// Reset the prompts reference first so setHistory publishes a genuinely
		// fresh empty list even when the previous one was already empty (the
		// existing [] snapshot must still reset listeners).
		this.taskHistoryPrompts = []
		// Fresh empty array so an existing [] snapshot reference still resets
		// listeners that hold the previous list.
		this.setHistory([])
	}

	public handleState(message: ExtensionMessage) {
		this.hydrate(message.state)
	}

	/**
	 * Apply a state slice directly — the `{type:"state"}` post payload and the
	 * webview's boot-time `initialState` share this shape (one-shot seeding via
	 * the provider). Last-write-wins for `currentTaskItem`; `taskHistory` is
	 * only replaced when present (lean posts keep the current list).
	 */
	public hydrate(state: Partial<ExtensionState> | undefined) {
		// `currentTaskItem` is last-write-wins like the rest of the state post.
		// Update the private field BEFORE any publish below so every snapshot
		// that goes out carries it (interned like the history entries).
		const incoming = state?.currentTaskItem
		this.currentTaskItem = incoming ? this.historyRegistry.intern(incoming) : undefined
		// The prompt-history workspace filter reads `cwd`, which rides
		// along on every state post; apply it BEFORE the list so a
		// first hydration derives with the right workspace.
		this.setWorkspace(state?.cwd)
		// Commit 4 made the state posts lean: the extension OMITS the
		// taskHistory key when includeTaskHistory is false (conditional
		// spread), so an absent key must keep the current list.
		if (state?.taskHistory !== undefined) {
			this.replaceAll(state.taskHistory)
		}
		// A lean post that only moved `currentTaskItem` must still reach
		// subscribers: setHistory re-checks every field and publishes exactly
		// when the snapshot reference changed (skip-notify otherwise).
		this.setHistory(this.history)
	}

	public handleTaskHistoryUpdated(message: ExtensionMessage) {
		if (message.taskHistory !== undefined) {
			this.replaceAll(message.taskHistory)
		}
	}

	public handleTaskHistoryItemUpdated(message: ExtensionMessage) {
		if (message.taskHistoryItem !== undefined) {
			// Mirror the old provider-side guard: only re-sync the active
			// task's `currentTaskItem` when the upserted item IS that task;
			// background-task updates touch the history list only. Assign
			// BEFORE the upsert so the publish below carries the fresh value.
			if (this.currentTaskItem?.id === message.taskHistoryItem.id) {
				this.currentTaskItem = this.historyRegistry.intern(message.taskHistoryItem)
			}
			this.upsertItem(message.taskHistoryItem)
		}
	}

	/** Test-only: number of interned strings (StringCache.size). */
	getCacheSize(): number {
		return this.historyRegistry.stringCacheSize
	}
}

/** Module singleton used by the app (provider mounts start/stop it). */
export const taskHistoryStore = new TaskHistoryStore()
