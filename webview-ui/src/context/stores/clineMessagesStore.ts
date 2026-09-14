import {
	type ClineMessage,
	type CompletionCheckpoint,
	type ExtensionMessage,
	type TodoItem,
	type TokenUsage,
	getCompletionCheckpoint,
} from "@roo-code/types"

import { findLastIndex } from "@roo/array"
import { combineApiRequests } from "@roo/combineApiRequests"
import { combineCommandSequences } from "@roo/combineCommandSequences"
import { getApiMetrics, hasTokenUsageChanged } from "@roo/getApiMetrics"
import { getLatestTodo } from "@roo/todo"

import { CanonicalRegistry, sameElements } from "./dedupRegistry"

/**
 * ClineMessagesStore — the frontend slice that owns the task's `clineMessages`
 * OUTSIDE of React state (Commit 2 of plans/streaming-event-architecture.md).
 *
 * Problem: every streaming push previously went through
 * `ExtensionStateContextProvider` → `setState` → new `contextValue` → re-render
 * of every consumer (including the memoized TaskHeader, whose memo is defeated
 * by context identity churn).
 *
 * This store moves `clineMessages` out of the context state and exposes a
 * useSyncExternalStore-shaped snapshot so only components that subscribe to the
 * store re-render when messages change. It is deliberately written in the
 * factory form that Commit 3 generalizes into `createSliceStore` (see §7.3 of
 * the plan): the domain reducer lives here, in concrete form, and the generic
 * slice factory later reuses the same shape.
 *
 * The store is STORE-shaped, not bus-shaped (§7.3): messages are state, not
 * events. The stream consumer hands Virtuoso the whole array and needs a
 * consistent snapshot plus stable element references between flushes (memoized
 * ChatRow, computeItemKey). Ordering / seq / dedupe / last-write-wins are all
 * reduced HERE so subscribers don't reimplement them.
 *
 * Domain semantics (mirroring the previous ExtensionStateContext behavior):
 * - `replaceAll(messages, seq)`: full-state hydration with the seq guard moved
 *   from `mergeExtensionState` — skip when incoming seq <= last applied seq.
 * - `applyUpdates(update)`: last-write-wins replace by `ts`; unknown `ts`
 *   APPENDS instead of the old "console.warn + drop".
 * - Canonicalization: every message flows through the task-scoped
 *   `CanonicalRegistry` keyed by `ts`. The registry interns non-partial
 *   messages' strings internally (partials are transient, their text churns
 *   every tick) and keeps ONE canonical instance per content, so an
 *   identical-content re-post of the full list — or a duplicate update —
 *   publishes nothing.
 * - Task switch: the `state` handler detects a `currentTaskId` change and
 *   clears the previous task's messages + interned strings before hydrating
 *   the new one. `clear()` (also used by the provider on mount / tests) does
 *   the same and additionally resets the seq baseline.
 * - Skip-notify: no listener is called when the snapshot did not change.
 *
 * Self-hydration: the module singleton starts a `window` "message" listener
 * (`start()`/`stop()`) so streaming events reach the store without a bus on the
 * IPC → store path (§7.3). Tests hydrate via `window.dispatchEvent(new
 * MessageEvent("message", { data: { type: "state", state: { clineMessages,
 * clineMessagesSeq, currentTaskId } } }))` — the same delivery the real
 * extension host uses.
 */
/**
 * Boolean bundle the shell's isStreaming logic reacts to. Lives inside the
 * derived slice so subscribers get a reference that only changes when one of
 * the flags actually flips, never while plain text is being appended.
 */
export interface LastMessageFlags {
	lastIsAsk: boolean
	lastIsPartial: boolean
	hasOpenApiRequest: boolean
}

/**
 * Derived data slice of the store (plans/derived-store-revision.md §2.1).
 *
 * Every field is a pure function of the message snapshot, recomputed exactly
 * once per real snapshot change inside `setMessages` — consumers (the ChatView
 * shell, MessageStream rows) never recompute these themselves. Field identity
 * is stabilized so subscribers only re-render on boundary events:
 *
 * - `lastMessage` is swapped only when its boundary key
 *   (`ts|type|say|ask|partial|isAnswered`) changes — text growth inside a
 *   partial keeps the previous object reference, reproducing the old boundary
 *   signature semantics 1-1.
 * - `apiMetrics` keeps the previous reference while `hasTokenUsageChanged`
 *   reports no difference.
 * - `latestTodos` keeps the previous reference while the JSON signature is
 *   equal (`getLatestTodo` allocates a fresh array on every parse).
 * - `completionCheckpoint` keeps the previous reference while `ts|commitHash`
 *   is equal.
 * - Primitives are `Object.is` stable on their own.
 * - `modifiedMessages` is deliberately NOT boundary-stabilized: the row render
 *   pipeline must observe every partial-text growth. Only the empty case keeps
 *   the previous reference (task-switch / clear noise collapse).
 *
 * The slice object itself is recreated only when at least one field changed
 * reference; `clear()` resets it to the initial (empty-snapshot) value.
 */
export interface DerivedMessageState {
	task: ClineMessage | undefined
	lastMessage: ClineMessage | undefined
	count: number
	modifiedMessages: ClineMessage[]
	lastIsAsk: boolean
	lastIsPartial: boolean
	hasOpenApiRequest: boolean
	lastMessageFlags: LastMessageFlags
	hasCompletionResult: boolean
	completionResultTs: number | undefined
	completionCheckpoint: CompletionCheckpoint | undefined
	apiMetrics: TokenUsage
	latestTodos: TodoItem[]
}

const EMPTY_TOKEN_USAGE: TokenUsage = {
	totalTokensIn: 0,
	totalTokensOut: 0,
	totalCacheWrites: undefined,
	totalCacheReads: undefined,
	totalCost: 0,
	contextTokens: 0,
}

/**
 * Boundary identity key for a message. Two messages sharing a key are
 * interchangeable for the shell's UI machine: text content is NOT part of the
 * key, exactly like the fields the old MessageStream signature compared.
 */
const messageBoundaryKey = (message: ClineMessage | undefined): string | undefined =>
	message === undefined
		? undefined
		: `${message.ts}|${message.type}|${message.say ?? ""}|${message.ask ?? ""}|${message.partial === true}|${message.isAnswered === true}`

const lastMessageFlagsEqual = (a: LastMessageFlags, b: LastMessageFlags): boolean =>
	a.lastIsAsk === b.lastIsAsk && a.lastIsPartial === b.lastIsPartial && a.hasOpenApiRequest === b.hasOpenApiRequest

const completionCheckpointEqual = (a: CompletionCheckpoint | undefined, b: CompletionCheckpoint | undefined): boolean =>
	a === b || (!!a && !!b && a.ts === b.ts && a.commitHash === b.commitHash)

/**
 * Scans backwards for the ts of the last completion-result row: a `say`, or an
 * `ask` whose text is non-empty (an ask still streaming its text does not
 * count). Mirrors the old MessageStream boundary memo exactly.
 */
const findCompletionResultTs = (messages: ClineMessage[]): number | undefined => {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message?.type === "say" && message.say === "completion_result") {
			return message.ts
		}
		if (message?.type === "ask" && message.ask === "completion_result" && (message.text ?? "") !== "") {
			return message.ts
		}
	}
	return undefined
}

const initialDerived: DerivedMessageState = {
	task: undefined,
	lastMessage: undefined,
	count: 0,
	modifiedMessages: [],
	lastIsAsk: false,
	lastIsPartial: false,
	hasOpenApiRequest: false,
	lastMessageFlags: { lastIsAsk: false, lastIsPartial: false, hasOpenApiRequest: false },
	hasCompletionResult: false,
	completionResultTs: undefined,
	completionCheckpoint: undefined,
	apiMetrics: EMPTY_TOKEN_USAGE,
	latestTodos: [],
}

export interface ClineMessagesStore {
	/** useSyncExternalStore contract: current immutable snapshot. */
	getSnapshot: () => ClineMessage[]
	/** useSyncExternalStore contract: returns an unsubscribe function. */
	subscribe: (listener: () => void) => () => void

	/**
	 * Current derived slice (immutable: per-flush new object or the previous
	 * one, never mutated after publication). Recomputed inside `setMessages`
	 * exactly once per real snapshot change and reset by `clear()`.
	 */
	getDerived: () => DerivedMessageState

	/**
	 * Full-state hydration (a `{type:"state"}` post). Applies the seq guard:
	 * when both the incoming and the stored seq are defined and the incoming is
	 * NOT strictly greater, the new messages are ignored (a stale push must not
	 * overwrite newer ones). Canonicalizes the array (string interning + one
	 * reference per `ts`) before publishing; a re-post whose every element maps
	 * back to the current snapshot publishes nothing (skip-notify).
	 */
	replaceAll: (messages: ClineMessage[], seq?: number) => void

	/**
	 * Streaming update — `{type:"messageUpdated", clineMessage}` (single) or a
	 * batch (Commit 1's `messagesUpdated` shape). Last-write-wins by `ts`;
	 * unknown `ts` values are appended (state sync issue, no longer silently
	 * dropped). Each update passes through the registry: an identical-content
	 * duplicate publishes nothing, a genuinely changed same-ts payload is
	 * adopted as the new canonical.
	 */
	applyUpdates: (updates: ClineMessage | ClineMessage[]) => void

	/**
	 * Drop messages, seq and the interned strings. The whole old ChatView tree
	 * is unmounted at this point (`key={currentTaskId}` in App.tsx), so nothing
	 * references the cached strings anymore.
	 */
	clear: () => void

	/** Last applied sequence number (undefined when no seq has been seen). */
	getSeq: () => number | undefined

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

const isMessagesUpdated = (
	message: ExtensionMessage,
): message is ExtensionMessage & { clineMessages: ClineMessage[] } =>
	message.type === "messageUpdated" && Array.isArray((message as { clineMessages?: unknown }).clineMessages)

const isSingleMessageUpdated = (
	message: ExtensionMessage,
): message is ExtensionMessage & { clineMessage: ClineMessage } =>
	message.type === "messageUpdated" && message.clineMessage !== undefined

/**
 * Factory form (generalized by `createSliceStore` in Commit 3). Each instance
 * owns its own messages, seq, listener set and task-scoped canonical registry
 * (string interning included), so tests can construct isolated stores without
 * cross-test leakage.
 */
export const createClineMessagesStore = (): ClineMessagesStore => {
	let messages: ClineMessage[] = []
	let derived: DerivedMessageState = initialDerived
	let seq: number | undefined
	const listeners = new Set<() => void>()
	// Canonical instance per `ts`; the registry owns the string interning (its
	// filter skips partial messages). The `partial` fast path below keeps the
	// streaming hot path from ever paying the JSON.stringify comparison: a
	// partial is fresh content by definition, so it is always adopted.
	const messageRegistry = new CanonicalRegistry<ClineMessage>((msg) => msg.ts, {
		shouldInternString: (msg) => !msg.partial,
		contentEquals: (incoming, canonical) =>
			incoming.partial !== true && JSON.stringify(incoming) === JSON.stringify(canonical),
	})
	let started = false
	// Last task id observed in a `{type:"state"}` post. A change means the old
	// ChatView tree (key={currentTaskId} in App.tsx) has been unmounted and the
	// previous task's messages + interned strings are unreachable → clear.
	let lastTaskId: string | undefined

	const notify = () => {
		for (const listener of listeners) {
			listener()
		}
	}

	/**
	 * Recomputes the derived slice for `msgs`, reusing `prev` field references
	 * wherever the identity rules documented on DerivedMessageState say the
	 * value has not effectively changed. Pure function of (prev, msgs) — no
	 * subscriptions, no window access (self-hydration stays snapshot-only).
	 */
	const derive = (prev: DerivedMessageState, msgs: ClineMessage[]): DerivedMessageState => {
		const task = msgs.at(0)

		// lastMessage: only a boundary-key change swaps the reference, so the
		// shell's UI machine (keyed on [lastMessage]) ignores partial-text
		// growth — 1-1 with the old signature gating.
		const lastMessageCandidate = msgs.at(-1)
		const lastMessage =
			messageBoundaryKey(lastMessageCandidate) === messageBoundaryKey(prev.lastMessage)
				? prev.lastMessage
				: lastMessageCandidate

		// The collapsed row stream (API request + command sequences merged into
		// their initiating row). NOT boundary-stabilized on purpose: the render
		// pipeline must observe every partial-text growth. Element-wise identity
		// reuse keeps the array reference (and so the whole slice) stable when
		// an identical snapshot is re-published.
		const modifiedCandidate = combineApiRequests(combineCommandSequences(msgs.slice(1)))
		const modifiedMessages = sameElements(modifiedCandidate, prev.modifiedMessages)
			? prev.modifiedMessages
			: modifiedCandidate

		const lastModified = modifiedMessages.at(-1)
		const lastIsAsk = !!lastModified?.ask
		const lastIsPartial = lastModified?.partial === true

		const lastApiReqStartedIndex = findLastIndex(
			modifiedMessages,
			(message: ClineMessage) => message.say === "api_req_started",
		)
		const lastApiReqStarted = lastApiReqStartedIndex === -1 ? undefined : modifiedMessages[lastApiReqStartedIndex]
		const hasOpenApiRequest = !!(
			lastApiReqStarted &&
			lastApiReqStarted.text !== null &&
			lastApiReqStarted.text !== undefined &&
			(() => {
				try {
					return JSON.parse(lastApiReqStarted.text ?? "{}").cost === undefined
				} catch {
					return false
				}
			})()
		)

		const lastMessageFlags: LastMessageFlags = { lastIsAsk, lastIsPartial, hasOpenApiRequest }

		const apiMetricsCandidate = getApiMetrics(modifiedMessages)
		const apiMetrics = hasTokenUsageChanged(apiMetricsCandidate, prev.apiMetrics)
			? apiMetricsCandidate
			: prev.apiMetrics

		// getLatestTodo parses the whole history into a fresh array on every
		// call — JSON signature equality is the only way to keep identity.
		const latestTodosCandidate = getLatestTodo(msgs) as TodoItem[]
		const latestTodos =
			JSON.stringify(latestTodosCandidate) === JSON.stringify(prev.latestTodos)
				? prev.latestTodos
				: latestTodosCandidate

		const completionCheckpointCandidate = getCompletionCheckpoint(msgs)
		const completionCheckpoint = completionCheckpointEqual(completionCheckpointCandidate, prev.completionCheckpoint)
			? prev.completionCheckpoint
			: completionCheckpointCandidate

		const next: DerivedMessageState = {
			task,
			lastMessage,
			count: msgs.length,
			modifiedMessages,
			lastIsAsk,
			lastIsPartial,
			hasOpenApiRequest,
			lastMessageFlags,
			hasCompletionResult: msgs.some((msg) => msg.ask === "completion_result" || msg.say === "completion_result"),
			completionResultTs: findCompletionResultTs(msgs),
			completionCheckpoint,
			apiMetrics,
			latestTodos,
		}

		// Whole-slice identity: reuse prev only when EVERY field link is
		// unchanged, so a "subscribe to the whole slice" consumer re-renders
		// only when something actually moved.
		const fieldsUnchanged =
			next.task === prev.task &&
			next.lastMessage === prev.lastMessage &&
			next.count === prev.count &&
			next.modifiedMessages === prev.modifiedMessages &&
			next.lastIsAsk === prev.lastIsAsk &&
			next.lastIsPartial === prev.lastIsPartial &&
			next.hasOpenApiRequest === prev.hasOpenApiRequest &&
			lastMessageFlagsEqual(next.lastMessageFlags, prev.lastMessageFlags) &&
			next.hasCompletionResult === prev.hasCompletionResult &&
			next.completionResultTs === prev.completionResultTs &&
			next.completionCheckpoint === prev.completionCheckpoint &&
			next.apiMetrics === prev.apiMetrics &&
			next.latestTodos === prev.latestTodos
		return fieldsUnchanged ? prev : next
	}

	const setMessages = (next: ClineMessage[]) => {
		if (next === messages) {
			// No reference change — nothing to publish (skip-notify).
			return
		}
		messages = next
		// Recompute the derived slice exactly once per real snapshot change,
		// BEFORE notifying so subscribers always observe a derived consistent
		// with the snapshot they just read.
		derived = derive(derived, next)
		notify()
	}

	const replaceAll = (incoming: ClineMessage[], incomingSeq?: number) => {
		// Seq guard (moved verbatim from mergeExtensionState): only apply
		// clineMessages when the incoming seq is strictly greater than the last
		// applied seq. When either side is undefined (backward compat / first
		// push), always apply.
		if (incomingSeq !== undefined && seq !== undefined && incomingSeq <= seq) {
			return
		}
		// Canonicalize BEFORE publishing: string fields re-bind to the shared
		// instances and every element maps back to the registered reference for
		// its ts. A full-state re-post with unchanged content comes back
		// element-wise equal to the current snapshot → nothing to publish.
		const canonical = messageRegistry.internList(incoming)
		// The seq advances even when dedup collapses the post to a no-op: the
		// guard must still reflect the post that was just seen.
		seq = incomingSeq
		if (sameElements(canonical, messages)) {
			return
		}
		setMessages(canonical)
	}

	const applyUpdates = (updates: ClineMessage | ClineMessage[]) => {
		const batch = Array.isArray(updates) ? updates : [updates]
		if (batch.length === 0) {
			return
		}
		let next: ClineMessage[] | undefined
		for (const update of batch) {
			// Interning + canonical reference in one step: an identical-content
			// duplicate maps back to the instance already in the snapshot (the
			// `working[lastIndex] === canonical` check below then skips it),
			// while a genuinely changed same-ts payload (partial text growth,
			// isAnswered, api-cost) is adopted as the new canonical.
			const canonical = messageRegistry.intern(update)
			const lastIndex = findLastIndex(messages, (msg) => msg.ts === canonical.ts)
			if (lastIndex !== -1) {
				const working = next ?? messages
				if (working[lastIndex] === canonical) {
					// Duplicate update — the snapshot already carries it.
					continue
				}
				const replaced = working.slice()
				replaced[lastIndex] = canonical
				next = replaced
			} else {
				// Unknown ts: append instead of dropping. With the seq guard and
				// cloud event isolation this should not happen under normal
				// conditions, but appending is the convergent behavior — a later
				// full-state push still reconciles the array.
				next = [...(next ?? messages), canonical]
			}
		}
		if (next !== undefined) {
			setMessages(next)
		}
	}

	const clear = () => {
		// Drops the canonical references AND the interned strings (the registry
		// owns the StringCache).
		messageRegistry.clear()
		seq = undefined
		// Reset derived to initial even when the snapshot was already empty
		// (setMessages would short-circuit on the reference check).
		derived = initialDerived
		setMessages([])
	}

	const handleMessage = (event: MessageEvent) => {
		const message = event.data as ExtensionMessage
		switch (message.type) {
			case "state": {
				const newState = message.state ?? {}
				// Task switch: the old ChatView tree is unmounted at this point
				// (key={currentTaskId} in App.tsx), so drop its messages AND its
				// interned strings before hydrating the new task's. clear() also
				// resets the seq so the new task starts from an undefined
				// baseline (its own first full-state post re-establishes it).
				const newTaskId = newState.currentTaskId
				if (newTaskId !== undefined && newTaskId !== lastTaskId) {
					clear()
					lastTaskId = newTaskId
				}
				if (newState.clineMessages !== undefined) {
					replaceAll(newState.clineMessages, newState.clineMessagesSeq)
				}
				break
			}
			case "messageUpdated": {
				if (isMessagesUpdated(message)) {
					// Commit 1's batched shape (adapter converges here).
					applyUpdates(message.clineMessages)
				} else if (isSingleMessageUpdated(message)) {
					applyUpdates(message.clineMessage)
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
		getSnapshot: () => messages,
		getDerived: () => derived,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		replaceAll,
		applyUpdates,
		clear,
		getSeq: () => seq,
		start,
		stop,
		getCacheSize: () => messageRegistry.stringCacheSize,
	}
}

/** Module singleton used by the app (provider mounts start/stop it). */
export const clineMessagesStore = createClineMessagesStore()
