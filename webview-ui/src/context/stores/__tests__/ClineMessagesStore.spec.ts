import { type ClineMessage } from "@roo-code/types"

import { createClineMessagesStore } from "../clineMessagesStore"

// Minimal task-say message factory matching the real ClineMessage shape used in
// tests elsewhere (ts/text/partial/type/say).
const makeMessage = (ts: number, text: string, partial?: boolean): ClineMessage =>
	({
		type: "say",
		say: "task",
		ts,
		text,
		...(partial !== undefined ? { partial } : {}),
	}) as ClineMessage

// Note: `window.postMessage` is async in jsdom (the event is queued as a task),
// so tests use a synchronous dispatch — the same pattern as ChatView.spec.tsx's
// dispatchExtensionMessage. The store listens via addEventListener("message"),
// which both delivery mechanisms trigger.
const dispatchWindowMessage = (data: unknown) => {
	window.dispatchEvent(new MessageEvent("message", { data }))
}

describe("ClineMessagesStore", () => {
	let store: ReturnType<typeof createClineMessagesStore>

	beforeEach(() => {
		store = createClineMessagesStore()
	})

	describe("replaceAll", () => {
		it("hydrates messages and returns them from the snapshot", () => {
			const messages = [makeMessage(1, "a"), makeMessage(2, "b")]
			store.replaceAll(messages)

			expect(store.getSnapshot()).toBe(messages)
		})

		it("replaces the previous array entirely", () => {
			store.replaceAll([makeMessage(1, "old")])
			const fresh = [makeMessage(1, "new")]
			store.replaceAll(fresh)

			expect(store.getSnapshot()).toHaveLength(1)
			expect(store.getSnapshot()[0]?.text).toBe("new")
		})

		it("keeps canonical element references across identical-content re-posts", () => {
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b")])
			const canonical = store.getSnapshot()

			// A structured-clone twin of the same content: every element maps back
			// to the registered canonical, and the snapshot keeps its reference.
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b")])
			expect(store.getSnapshot()).toBe(canonical)
			expect(store.getSnapshot()[0]).toBe(canonical[0])

			// Genuinely changed content is adopted as the new canonical element...
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b2")])
			const grown = store.getSnapshot()
			expect(grown).not.toBe(canonical)
			expect(grown[0]).toBe(canonical[0]) // unchanged element keeps its reference
			expect(grown[1]?.text).toBe("b2")

			// ...and a later twin of THAT post maps back to the adopted instance.
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b2")])
			expect(store.getSnapshot()).toBe(grown)
		})

		it("applies the seq guard: rejects seq <= stored seq", () => {
			const newer = [makeMessage(2, "newer")]
			store.replaceAll([makeMessage(1, "first")], 5)
			store.replaceAll(newer, 5) // equal seq — stale

			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1])
			expect(store.getSeq()).toBe(5)

			store.replaceAll(newer, 3) // lower seq — stale
			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1])

			store.replaceAll(newer, 6) // strictly greater — applies
			expect(store.getSnapshot()).toBe(newer)
			expect(store.getSeq()).toBe(6)
		})

		it("applies messages when neither side has a seq (backward compat)", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			expect(store.getSnapshot()).toBe(messages)
			expect(store.getSeq()).toBeUndefined()
		})

		it("applies when stored seq is undefined but incoming has one (first seq push)", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages, 1)
			expect(store.getSnapshot()).toBe(messages)
			expect(store.getSeq()).toBe(1)
		})
	})

	describe("applyUpdates", () => {
		it("replaces an existing message by ts (last-write-wins)", () => {
			const original = { ...makeMessage(1, "before") }
			store.replaceAll([original, makeMessage(2, "other")])

			const updated = makeMessage(1, "after")
			store.applyUpdates(updated)

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(2)
			expect(snapshot[0]).toBe(updated)
			expect(snapshot[0]?.text).toBe("after")
			// Unrelated element keeps its reference.
			expect(snapshot[1]?.text).toBe("other")
		})

		it("appends a message with an unknown ts instead of dropping it", () => {
			store.replaceAll([makeMessage(1, "existing")])

			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

			const incoming = makeMessage(99, "unknown")
			store.applyUpdates(incoming)

			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1, 99])
			expect(store.getSnapshot()[1]).toBe(incoming)
			warnSpy.mockRestore()
		})

		it("handles a batch (Commit 1 messagesUpdated shape) in order", () => {
			store.replaceAll([makeMessage(1, "a")])
			store.applyUpdates([makeMessage(1, "a2"), makeMessage(3, "c")])

			expect(store.getSnapshot().map((m) => m.text)).toEqual(["a2", "c"])
		})

		it("is a no-op for an empty batch", () => {
			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			store.applyUpdates([])
			expect(store.getSnapshot()).toBe(messages)
		})

		it("suppresses an identical-content duplicate update (canonical mapping)", () => {
			const listener = vi.fn()
			store.replaceAll([makeMessage(1, "a")])
			store.subscribe(listener)

			// The same ts + same content arriving as a fresh object maps back to
			// the canonical element already in the snapshot → no publish.
			store.applyUpdates(makeMessage(1, "a"))
			expect(listener).not.toHaveBeenCalled()
			expect(store.getSnapshot()[0]?.text).toBe("a")
		})

		it("partial growth is never deduplicated (fresh content always adopted)", () => {
			store.applyUpdates(makeMessage(1, "hel", true))
			const firstPartial = store.getSnapshot()[0]

			// Same ts, same partial flag, grown text: a different object every
			// time, and the partial fast path adopts it without a deep compare.
			store.applyUpdates(makeMessage(1, "hello", true))
			expect(store.getSnapshot()[0]).not.toBe(firstPartial)
			expect(store.getSnapshot()[0]?.text).toBe("hello")
		})
	})

	describe("interning", () => {
		it("interns non-partial messages (canonical string instances shared across flushes)", () => {
			const first = [makeMessage(1, "shared text")]
			store.replaceAll(first)

			// A fresh push with equal text content must reuse the canonical
			// string instance held by the cache.
			const second = [makeMessage(1, "shared text"), makeMessage(2, "grown")]
			store.replaceAll(second)

			const snapshot = store.getSnapshot()
			const internedText = snapshot[0]?.text
			expect(internedText).toBe("shared text")
			// The message text field now points to the canonical instance from
			// the first flush (interned in place during replaceAll).
			const firstFlushText = first[0]?.text
			expect(snapshot[0]?.text).toBe(firstFlushText)
			// Cross-flush equal-content strings must share identity.
			expect(snapshot[1]?.text === "grown").toBe(true)
			expect(store.getCacheSize()).toBeGreaterThan(0)
		})

		it("does NOT intern partial messages (they pass through by reference)", () => {
			// Partial message: the same transient text repeated across flushes
			// must NOT pin stale prefixes in the cache.
			store.replaceAll([makeMessage(1, "prefix", true)])

			// Force the same content through again as partial — cache size must
			// not grow (partial subtrees are skipped by the filter).
			const cacheAfterFirst = store.getCacheSize()
			store.applyUpdates(makeMessage(2, "another partial", true))

			expect(store.getCacheSize()).toBe(cacheAfterFirst)
		})

		it("clears interned strings on clear()", () => {
			store.replaceAll([makeMessage(1, "some text")])
			expect(store.getCacheSize()).toBeGreaterThan(0)

			store.clear()
			expect(store.getCacheSize()).toBe(0)
		})
	})

	describe("subscription / skip-notify", () => {
		it("notifies subscribers when the snapshot reference changes", () => {
			const listener = vi.fn()
			const unsubscribe = store.subscribe(listener)

			store.replaceAll([makeMessage(1, "a")])
			expect(listener).toHaveBeenCalledTimes(1)

			store.applyUpdates(makeMessage(1, "a2"))
			expect(listener).toHaveBeenCalledTimes(2)

			unsubscribe()
			store.applyUpdates(makeMessage(1, "a3"))
			expect(listener).toHaveBeenCalledTimes(2)
		})

		it("skip-notify: no notification when the snapshot does not change", () => {
			const listener = vi.fn()
			store.subscribe(listener)

			const messages = [makeMessage(1, "a")]
			store.replaceAll(messages)
			expect(listener).toHaveBeenCalledTimes(1)

			// Structured-clone re-post: fresh array, same content. The registry
			// maps every element back to its canonical → element-wise equal to the
			// snapshot → nothing to publish.
			store.replaceAll([makeMessage(1, "a")])
			expect(listener).toHaveBeenCalledTimes(1)

			// The exact same array reference is likewise a no-op.
			store.replaceAll(messages)
			expect(listener).toHaveBeenCalledTimes(1)

			// Genuine content change DOES notify...
			store.replaceAll([makeMessage(1, "a-changed")], 10)
			expect(listener).toHaveBeenCalledTimes(2)

			// ...an identical-content re-post with a fresh seq passes the guard but
			// the registry collapses it back to the snapshot → still quiet.
			store.replaceAll([makeMessage(1, "a-changed")], 11)
			expect(listener).toHaveBeenCalledTimes(2)

			// ...while a stale seq push must not, even with new content.
			store.replaceAll([makeMessage(2, "b")], 5)
			expect(listener).toHaveBeenCalledTimes(2)
		})
	})

	describe("self-hydration (window message listener)", () => {
		it("hydrates from a full state post", () => {
			store.start()
			const messages = [makeMessage(1, "from state post")]

			dispatchWindowMessage({
				type: "state",
				state: { clineMessages: messages, clineMessagesSeq: 3 },
			})

			expect(store.getSnapshot()).toBe(messages)
			expect(store.getSeq()).toBe(3)
		})

		it("applies a messageUpdated post without setState on the provider", () => {
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { clineMessages: [makeMessage(1, "initial")], clineMessagesSeq: 1 },
			})

			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(1, "grown") })

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]?.text).toBe("grown")
		})

		it("stop() detaches the listener", () => {
			store.start()
			store.stop()

			dispatchWindowMessage({ type: "state", state: { clineMessages: [makeMessage(1, "ignored")] } })

			expect(store.getSnapshot()).toEqual([])
		})

		it("clears the previous task's messages when currentTaskId changes", () => {
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})

			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b", clineMessages: [makeMessage(2, "b")], clineMessagesSeq: 1 },
			})

			const snapshot = store.getSnapshot()
			expect(snapshot).toHaveLength(1)
			expect(snapshot[0]?.ts).toBe(2)
			// The interned strings of task-a were dropped before hydrating task-b.
			expect(store.getCacheSize()).toBeGreaterThan(0)
		})

		it("clears when currentTaskId changes even if the post omits clineMessages (Commit 4 lean posts)", () => {
			// Commit 4 made the queue-handler state post lean (no clineMessages).
			// A lean post is legal mid-task (same currentTaskId → no clear, see the
			// next test), but if it DOES carry a new currentTaskId the old task's
			// messages must still be dropped: its ChatView is unmounted (keyed by
			// currentTaskId) and the new task hydrates via its own full state post
			// that follows the switch. Holding on to task-a's rows under task-b's
			// header would be worse than a transient empty state.
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})
			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(2, "b") })

			// Task switch with NO clineMessages in the payload (bare state post).
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b" },
			})

			const snapshot = store.getSnapshot()
			expect(snapshot).toEqual([])
			expect(store.getSeq()).toBeUndefined()
			// Interned strings of task-a were released by the clear.
			expect(store.getCacheSize()).toBe(0)

			// The new task's own hydration then re-populates the store.
			const hydration = [makeMessage(10, "task-b msg")]
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-b", clineMessages: hydration, clineMessagesSeq: 1 },
			})
			expect(store.getSnapshot()).toBe(hydration)
		})

		it("does not clear when a same-task state post omits clineMessages (cloud event path)", () => {
			store.start()
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", clineMessages: [makeMessage(1, "a")], clineMessagesSeq: 1 },
			})
			dispatchWindowMessage({ type: "messageUpdated", clineMessage: makeMessage(2, "b") })

			// A cloud event push for the SAME task that omits clineMessages must
			// not wipe the accumulated messages.
			dispatchWindowMessage({
				type: "state",
				state: { currentTaskId: "task-a", cloudIsAuthenticated: true },
			})

			expect(store.getSnapshot().map((m) => m.ts)).toEqual([1, 2])
		})
	})

	describe("derived", () => {
		const makeApiReqStarted = (ts: number, usage: Record<string, number>): ClineMessage =>
			({
				type: "say",
				say: "api_req_started",
				ts,
				text: JSON.stringify(usage),
			}) as ClineMessage

		const makeTodoAsk = (ts: number, todos: unknown[]): ClineMessage =>
			({
				type: "ask",
				ask: "tool",
				ts,
				text: JSON.stringify({ tool: "updateTodoList", todos }),
			}) as ClineMessage

		it("is initial on an empty snapshot", () => {
			const derived = store.getDerived()

			expect(derived.task).toBeUndefined()
			expect(derived.lastMessage).toBeUndefined()
			expect(derived.count).toBe(0)
			expect(derived.modifiedMessages).toEqual([])
			expect(derived.lastIsAsk).toBe(false)
			expect(derived.lastIsPartial).toBe(false)
			expect(derived.hasOpenApiRequest).toBe(false)
			expect(derived.hasCompletionResult).toBe(false)
			expect(derived.completionResultTs).toBeUndefined()
			expect(derived.completionCheckpoint).toBeUndefined()
			expect(derived.apiMetrics).toEqual({
				totalTokensIn: 0,
				totalTokensOut: 0,
				totalCacheWrites: undefined,
				totalCacheReads: undefined,
				totalCost: 0,
				contextTokens: 0,
			})
			expect(derived.latestTodos).toEqual([])
		})

		it("identical replaceAll re-post keeps snapshot AND derived untouched (dedup skip-notify)", () => {
			const messages = [makeMessage(1, "a"), makeMessage(2, "b")]
			store.replaceAll(messages)
			const snapshot = store.getSnapshot()
			const first = store.getDerived()

			// With the canonical registry the old "fresh array, same elements"
			// shape can no longer reach setMessages: an identical-content re-post
			// maps back element-wise and the whole publish is skipped.
			const listener = vi.fn()
			store.subscribe(listener)
			store.replaceAll([makeMessage(1, "a"), makeMessage(2, "b")])

			expect(listener).not.toHaveBeenCalled()
			expect(store.getSnapshot()).toBe(snapshot)
			expect(store.getDerived()).toBe(first)
		})

		it("partial text growth: lastMessage reference does NOT change (boundary key), count stable", () => {
			store.replaceAll([makeMessage(1, "task"), makeMessage(2, "hel", true)])
			const partial = store.getDerived().lastMessage
			expect(partial?.text).toBe("hel")

			// Same ts/type/say/partial — only the text grew.
			store.applyUpdates(makeMessage(2, "hello world", true))

			const derived = store.getDerived()
			expect(derived.lastMessage).toBe(partial)
			expect(derived.count).toBe(2)
		})

		it("partial -> final: lastMessage is the NEW object carrying the final text", () => {
			store.replaceAll([makeMessage(1, "task"), makeMessage(2, "partial text", true)])
			const partial = store.getDerived().lastMessage

			store.applyUpdates(makeMessage(2, "final text"))

			const derived = store.getDerived()
			expect(derived.lastMessage).not.toBe(partial)
			expect(derived.lastMessage?.text).toBe("final text")
			expect(derived.lastMessage?.partial).toBeUndefined()
		})

		it("apiMetrics: identical usage keeps the reference (hasTokenUsageChanged), changed usage yields a new object with new values", () => {
			const usage = { tokensIn: 10, tokensOut: 20, cost: 0.5 }
			const messages = [makeMessage(1, "task"), makeApiReqStarted(2, usage)]
			store.replaceAll(messages)
			const metrics = store.getDerived().apiMetrics
			expect(metrics.totalTokensIn).toBe(10)
			expect(metrics.totalTokensOut).toBe(20)

			// Fresh array + fresh message object, identical parsed usage: the
			// TokenUsage reference must survive.
			store.replaceAll([messages[0]!, makeApiReqStarted(2, usage)])
			expect(store.getDerived().apiMetrics).toBe(metrics)

			// Changed usage: new reference AND new values.
			store.applyUpdates(makeApiReqStarted(2, { tokensIn: 30, tokensOut: 20, cost: 0.5 }))
			const updated = store.getDerived().apiMetrics
			expect(updated).not.toBe(metrics)
			expect(updated.totalTokensIn).toBe(30)
		})

		it("latestTodos: identical content keeps the array reference, changed content produces a new one", () => {
			const todos = [{ content: "one", status: "in_progress" }]
			const messages = [makeMessage(1, "task"), makeTodoAsk(2, todos)]
			store.replaceAll(messages)
			const first = store.getDerived().latestTodos
			expect(first).toEqual(todos)

			// getLatestTodo parses into a fresh array on every call — identity
			// must come from the JSON signature, not object equality.
			store.replaceAll([messages[0]!, makeTodoAsk(2, todos)])
			expect(store.getDerived().latestTodos).toBe(first)

			store.applyUpdates(makeTodoAsk(2, [{ content: "one", status: "completed" }]))
			const second = store.getDerived().latestTodos
			expect(second).not.toBe(first)
			expect(second).toEqual([{ content: "one", status: "completed" }])
		})

		it("clear() resets the derived slice to initial", () => {
			const usage = { tokensIn: 10, tokensOut: 20, cost: 0.5 }
			store.replaceAll([makeMessage(1, "task"), makeApiReqStarted(2, usage)], 3)
			expect(store.getDerived().count).toBe(2)
			expect(store.getDerived().apiMetrics.totalTokensIn).toBe(10)

			store.clear()
			const derived = store.getDerived()
			expect(derived.task).toBeUndefined()
			expect(derived.lastMessage).toBeUndefined()
			expect(derived.count).toBe(0)
			expect(derived.apiMetrics.totalTokensIn).toBe(0)
			expect(derived.latestTodos).toEqual([])

			// Derived is initial even after a clear on an already-empty store.
			store.clear()
			expect(store.getDerived().count).toBe(0)
		})

		it("flags: lastIsAsk/lastIsPartial/hasOpenApiRequest track the modified stream", () => {
			const openReq = makeApiReqStarted(2, { tokensIn: 1 })
			store.replaceAll([makeMessage(1, "task"), openReq])
			let derived = store.getDerived()
			expect(derived.lastIsAsk).toBe(false)
			expect(derived.hasOpenApiRequest).toBe(true)
			// The flag bundle is reference-stable while no flag flips.
			const flags = derived.lastMessageFlags

			store.applyUpdates({ ...openReq, text: JSON.stringify({ tokensIn: 2, cost: 0.1 }) } as ClineMessage)
			derived = store.getDerived()
			expect(derived.hasOpenApiRequest).toBe(false)
			expect(derived.lastMessageFlags).not.toBe(flags)
			expect(derived.lastMessageFlags).toEqual({
				lastIsAsk: false,
				lastIsPartial: false,
				hasOpenApiRequest: false,
			})
		})
	})

	describe("clear", () => {
		it("drops messages, seq, interned strings and canonical references", () => {
			store.replaceAll([makeMessage(1, "text")], 7)
			const before = store.getSnapshot()[0]
			store.clear()

			expect(store.getSnapshot()).toEqual([])
			expect(store.getSeq()).toBeUndefined()
			expect(store.getCacheSize()).toBe(0)

			// The registry was reset too: an identical-content re-post is now
			// adopted as a NEW canonical instead of mapping back to `before`.
			store.replaceAll([makeMessage(1, "text")])
			expect(store.getSnapshot()[0]).not.toBe(before)
		})
	})
})
